import "dotenv/config";
import { promises as fs } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { PepyDataSchema, PepyPackageSchema } from "../types";
import { saveJson, sleep } from "../utils";

const PEPY_BASE = "https://api.pepy.tech/api/v2/projects";

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

export async function collectPepyStats(): Promise<void> {
  console.log("Collecting PEPY download stats...");

  const configPath = join(process.cwd(), "config", "config.yaml");
  const config = yaml.load(await fs.readFile(configPath, "utf8")) as {
    core_packages: string[];
    // Extra PyPI projects whose downloads are added to a core package,
    // e.g. rapids-singlecell: [rapids-singlecell-cu12, rapids-singlecell-cu13]
    merged_projects?: Record<string, string[]>;
  };
  const mergedProjects: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(config.merged_projects ?? {})) {
    mergedProjects[normalizeName(k)] = v.map(normalizeName);
  }
  const memberToGroup = new Map<string, string>();
  for (const [group, members] of Object.entries(mergedProjects)) {
    for (const m of members) memberToGroup.set(m, group);
  }
  const projectsToFetch = config.core_packages.flatMap((pkg) => [
    pkg,
    ...(mergedProjects[normalizeName(pkg)] ?? []),
  ]);

  const packages: any[] = [];
  const perPackage30DayAvg: {
    id: string;
    total_30_days: number;
    avg_per_day: number;
  }[] = [];

  const apiKey = process.env.PEPY_API_KEY;

  if (!apiKey) {
    console.log("PEPY_API_KEY not set — skipping pepy collector");
    return;
  }

  // PEPY free tier: 10 requests/minute -> wait 6s between requests
  const delayMs = 6000;

  for (const pkg of projectsToFetch) {
    const project = normalizeName(pkg);
    const url = `${PEPY_BASE}/${encodeURIComponent(project)}`;

    try {
      const resp = await fetch(url, {
        headers: { "X-API-Key": apiKey },
      });

      if (resp.status === 404) {
        console.log(`  ${project}: not found`);
        packages.push({
          id: project,
          total_downloads: 0,
          versions: [],
          downloads: {},
        });
      } else if (resp.status === 401) {
        console.log("  PEPY API key invalid (401)");
        return;
      } else if (resp.status === 429) {
        console.log("  Rate limit exceeded (429) — stopping");
        break;
      } else if (!resp.ok) {
        console.log(`  ${project}: request failed (${resp.status})`);
        packages.push({
          id: project,
          total_downloads: 0,
          versions: [],
          downloads: {},
        });
      } else {
        const body = (await resp.json()) as any;
        try {
          const validated = PepyPackageSchema.parse({
            id: body.id || project,
            total_downloads: body.total_downloads || 0,
            versions: Array.isArray(body.versions) ? body.versions : [],
            downloads: body.downloads || {},
          });

          packages.push(validated);
          console.log(
            `  ${project}: ${validated.total_downloads} downloads`,
          );
        } catch (err) {
          console.log(`  ${project}: validation failed`);
          packages.push({
            id: project,
            total_downloads: body.total_downloads || 0,
            versions: body.versions || [],
            downloads: body.downloads || {},
          });
        }
      }
    } catch (err) {
      console.log(`  ${project}: fetch error`);
      packages.push({
        id: project,
        total_downloads: 0,
        versions: [],
        downloads: {},
      });
    }

    await sleep(delayMs);
  }

  // Fold merged projects (e.g. -cu12 / -cu13 builds) into their core package
  const mergedPackages: any[] = [];
  for (const p of packages) {
    const group = memberToGroup.get(p.id);
    if (!group) {
      mergedPackages.push(p);
      continue;
    }
    let target = mergedPackages.find((q) => q.id === group);
    if (!target) {
      target = { id: group, total_downloads: 0, versions: [], downloads: {} };
      mergedPackages.push(target);
    }
  }
  for (const p of packages) {
    const group = memberToGroup.get(p.id);
    const target = group
      ? mergedPackages.find((q) => q.id === group)
      : undefined;
    if (!target || target === p) continue;
    target.total_downloads += p.total_downloads || 0;
    target.versions = Array.from(
      new Set([...target.versions, ...(p.versions || [])]),
    );
    for (const [date, perVersion] of Object.entries(p.downloads || {})) {
      const day = (target.downloads[date] ??= {});
      for (const [ver, n] of Object.entries(perVersion as Record<string, number>)) {
        day[ver] = (day[ver] || 0) + (Number(n) || 0);
      }
    }
  }
  packages.length = 0;
  packages.push(...mergedPackages);

  // Last-30-day totals per (merged) package
  const today = new Date();
  for (const pkg of packages) {
    const downloadsObj = pkg.downloads || {};
    const sortedDates = Object.keys(downloadsObj).sort().reverse();
    let total30 = 0;
    let countedDays = 0;
    for (const dateStr of sortedDates) {
      if (countedDays >= 30) break;
      const d = new Date(dateStr + "T00:00:00Z");
      const diffDays = Math.floor(
        (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays < 0) continue; // future date
      if (diffDays >= 30) continue; // older than 30 days
      const perVersion = downloadsObj[dateStr] || {};
      total30 += Object.values(perVersion).reduce(
        (s: number, v: any) => s + (Number(v) || 0),
        0,
      );
      countedDays++;
    }
    perPackage30DayAvg.push({
      id: pkg.id,
      total_30_days: total30,
      avg_per_day: countedDays > 0 ? total30 / countedDays : 0,
    });
  }

  const total = packages.reduce((s, p) => s + (p.total_downloads || 0), 0);
  // Combine the per-package averages into overall metrics
  const combinedTotal30 = perPackage30DayAvg.reduce(
    (s, p) => s + p.total_30_days,
    0,
  );
  const combinedAvgDaily = perPackage30DayAvg.reduce(
    (s, p) => s + p.avg_per_day,
    0,
  );

  const validatedAll = PepyDataSchema.parse({
    packages,
    total_downloads: total,
    timestamp: new Date().toISOString(),
  });

  const out = {
    ...validatedAll,
    computed: {
      per_package_30_day: perPackage30DayAvg,
      combined_total_30_days: combinedTotal30,
      combined_avg_daily: combinedAvgDaily,
    },
  };

  await saveJson("pepy.json", out);
  console.log(
    `Total pepy downloads: ${validatedAll.total_downloads}, combined 30-day avg daily: ${combinedAvgDaily.toFixed(1)}`,
  );
}
