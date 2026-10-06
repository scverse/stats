import "dotenv/config";
import { promises as fs } from "fs";
import { join } from "path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { ZulipActivityDataSchema, ZulipActivityData } from "../types";
import { saveJson } from "../utils";

// Same data as the charts on <realm>/stats, from the Zulip analytics API.
async function fetchChartData(chartName: string): Promise<any> {
  const realm = process.env.ZULIP_REALM!.replace(/\/$/, "");
  const auth = Buffer.from(
    `${process.env.ZULIP_EMAIL}:${process.env.ZULIP_API_KEY}`,
  ).toString("base64");

  const res = await fetch(
    `${realm}/api/v1/analytics/chart_data?chart_name=${chartName}`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const body: any = await res.json();
  if (!res.ok || body.result !== "success") {
    throw new Error(`Zulip chart_data ${chartName} failed: ${body.msg}`);
  }
  return body;
}

function toDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export async function collectZulipActivityStats(): Promise<void> {
  console.log("Collecting Zulip activity stats...");

  const [humans, read] = await Promise.all([
    fetchChartData("number_of_humans"),
    fetchChartData("messages_read_over_time"),
  ]);

  // Messages read may be reported hourly; aggregate to daily counts.
  const readPerDay = new Map<string, number>();
  read.end_times.forEach((t: number, i: number) => {
    const day = toDay(t);
    readPerDay.set(day, (readPerDay.get(day) ?? 0) + read.everyone.read[i]);
  });

  let totalRead = 0;
  const days = humans.end_times.map((t: number, i: number) => {
    const date = toDay(t);
    totalRead += readPerDay.get(date) ?? 0;
    return {
      date,
      total_users: humans.everyone.all_time[i],
      active_users_15day: humans.everyone._15day[i],
      total_messages_read: totalRead,
    };
  });

  const latest = days[days.length - 1];
  const validated = ZulipActivityDataSchema.parse({
    total_users: latest.total_users,
    active_users_15day: latest.active_users_15day,
    total_messages_read: latest.total_messages_read,
    days,
    timestamp: new Date().toISOString(),
  });

  await saveJson("zulip_activity.json", validated);
  await renderZulipActivityChart(validated);
  console.log(`Zulip active users (15 days): ${latest.active_users_15day}`);
}

// Least-squares line through the active users series.
function linearTrend(ys: number[]): number[] {
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  const slope = den ? num / den : 0;
  return ys.map((_, x) => meanY + slope * (x - meanX));
}

// Pick one interval count shared by all y axes, and a "nice" step per axis,
// so every axis has its ticks at the same heights. Each series is stretched
// to fill its axis; the count that leaves the least empty space wins.
function alignedYScales(maxima: number[]): { min: number; max: number; stepSize: number }[] {
  const NICE = [1, 1.5, 2, 2.5, 3, 4, 5];
  const niceStep = (max: number, intervals: number) => {
    const raw = Math.max(max, 1) / intervals;
    for (let exp = Math.floor(Math.log10(raw)); ; exp++) {
      for (const f of NICE) {
        const step = f * 10 ** exp;
        if (step >= raw) return step;
      }
    }
  };

  let best: { fill: number; steps: number[]; intervals: number } | null = null;
  for (let intervals = 3; intervals <= 6; intervals++) {
    const steps = maxima.map((m) => niceStep(m, intervals));
    const fill = Math.min(...maxima.map((m, i) => m / (steps[i] * intervals)));
    if (!best || fill > best.fill) best = { fill, steps, intervals };
  }
  return best!.steps.map((stepSize) => ({
    min: 0,
    max: stepSize * best!.intervals,
    stepSize,
  }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function renderZulipActivityChart(data: ZulipActivityData): Promise<void> {
  const GREEN = "#5fb47c";
  const BLUE = "#4a7fc1";
  const PINK = "#e07aaa";

  const x = data.days.map((d) => Date.parse(d.date));
  const series = (ys: number[]) => ys.map((y, i) => ({ x: x[i], y }));
  const users = data.days.map((d) => d.total_users);
  const messages = data.days.map((d) => d.total_messages_read);
  const active = data.days.map((d) => d.active_users_15day);
  const [usersScale, messagesScale, activeScale] = alignedYScales([
    Math.max(...users),
    Math.max(...messages),
    Math.max(...active),
  ]);

  const FONT_SIZE = 28;

  const axisTitle = (text: string, color: string) => ({
    display: true,
    text,
    color,
    font: { size: FONT_SIZE, weight: "bold" as const },
  });

  // Tick marks and axis lines, drawn outside the chart area.
  const axisStyle = {
    border: { width: 2 },
    grid: { drawOnChartArea: false, tickLength: 16, tickWidth: 2 },
  };

  const canvas = new ChartJSNodeCanvas({
    width: 1600,
    height: 600,
    backgroundColour: "white",
  });

  const image = await canvas.renderToBuffer({
    type: "line",
    data: {
      datasets: [
        {
          label: "Total users",
          data: series(users),
          borderColor: BLUE,
          yAxisID: "users",
        },
        {
          label: "Total read messages",
          data: series(messages),
          borderColor: GREEN,
          yAxisID: "messages",
        },
        {
          label: "Active users (2 weeks window)",
          data: series(active),
          borderColor: PINK,
          yAxisID: "active",
        },
        {
          label: "Active users trend",
          data: series(linearTrend(active)),
          borderColor: PINK,
          borderDash: [12, 12],
          borderWidth: 4,
          yAxisID: "active",
        },
      ],
    },
    options: {
      animation: false,
      devicePixelRatio: 2,
      layout: { padding: 16 },
      elements: { point: { radius: 0 }, line: { borderWidth: 3 } },
      plugins: {
        legend: {
          labels: {
            font: { size: FONT_SIZE + 4 },
            boxHeight: 3,
            padding: 40,
            filter: (item) => item.text !== "Active users trend",
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: x[0],
          max: x[x.length - 1],
          border: { width: 2 },
          grid: { tickLength: 16, tickWidth: 2 },
          // Tick on every January and July.
          afterBuildTicks: (axis) => {
            const ticks = [];
            const start = new Date(x[0]);
            for (
              let d = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
              d.getTime() <= x[x.length - 1];
              d.setUTCMonth(d.getUTCMonth() + 6)
            ) {
              if (d.getTime() >= x[0]) ticks.push({ value: d.getTime() });
            }
            axis.ticks = ticks;
          },
          ticks: {
            font: { size: FONT_SIZE },
            minRotation: 30,
            maxRotation: 30,
            callback: (value) => {
              const d = new Date(value as number);
              return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
            },
          },
        },
        messages: {
          position: "left",
          min: messagesScale.min,
          max: messagesScale.max,
          title: axisTitle("Total read messages", GREEN),
          ...axisStyle,
          ticks: {
            stepSize: messagesScale.stepSize,
            font: { size: FONT_SIZE },
            color: GREEN,
            callback: (value) => {
              const v = value as number;
              if (v >= 1e6) return `${v / 1e6}M`;
              if (v >= 1e3) return `${v / 1e3}k`;
              return v;
            },
          },
        },
        users: {
          position: "left",
          min: usersScale.min,
          max: usersScale.max,
          title: axisTitle("Total users", BLUE),
          border: { width: 2 },
          grid: { tickLength: 16, tickWidth: 2 },
          ticks: {
            stepSize: usersScale.stepSize,
            font: { size: FONT_SIZE },
            color: BLUE,
          },
        },
        active: {
          position: "right",
          min: activeScale.min,
          max: activeScale.max,
          title: axisTitle("Active users (2 weeks window)", PINK),
          ...axisStyle,
          ticks: {
            stepSize: activeScale.stepSize,
            font: { size: FONT_SIZE },
            color: PINK,
          },
        },
      },
    },
  });

  const outputPath = join(process.cwd(), "output", "zulip_activity.png");
  await fs.writeFile(outputPath, image);
  console.log("Saved zulip_activity.png");
}
