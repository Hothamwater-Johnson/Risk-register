"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReportData } from "@/lib/autoTrader";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const tooltipStyle = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
} as const;

const axis = { tick: { fontSize: 11 }, stroke: "currentColor", opacity: 0.5 } as const;

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-xs font-semibold">{title}</div>
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AutoTraderReport({ data }: { data: ReportData }) {
  if (data.series.length <= 1 && data.series[0]?.tradeCount === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-10 text-center text-sm text-muted">
        No trading data yet. Once the bot opens trades and you clear a session or
        two, the charts populate here.
      </p>
    );
  }

  const chart = data.series.map((p) => ({
    label: p.label,
    cumulative: Math.round(p.cumulativePnlUsd * 100) / 100,
    realized: Math.round(p.realizedPnlUsd * 100) / 100,
    expected: Math.round(p.expectedPnlUsd * 100) / 100,
    capture: p.captureRatio === null ? null : Math.round(p.captureRatio * 100),
    active: p.active,
  }));

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ChartCard title="Cumulative realized P&L">
        <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" {...axis} />
          <YAxis tickFormatter={(v: number) => `$${v}`} {...axis} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v) => [usd(Number(v)), "Cumulative"]}
          />
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        </LineChart>
      </ChartCard>

      <ChartCard title="Realized P&L per session">
        <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" {...axis} />
          <YAxis tickFormatter={(v: number) => `$${v}`} {...axis} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v) => [usd(Number(v)), "Realized"]}
          />
          <Bar dataKey="realized">
            {chart.map((d, i) => (
              <Cell
                key={i}
                fill={d.realized >= 0 ? "var(--positive)" : "var(--negative)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartCard>

      <ChartCard title="Capture ratio per session (%)">
        <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" {...axis} />
          <YAxis tickFormatter={(v: number) => `${v}%`} {...axis} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v) => [v === null ? "—" : `${v}%`, "Capture"]}
          />
          <Line
            type="monotone"
            dataKey="capture"
            stroke="var(--positive)"
            strokeWidth={2}
            dot={{ r: 2 }}
            connectNulls
          />
        </LineChart>
      </ChartCard>

      <ChartCard title="Expected vs realized P&L">
        <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeOpacity={0.1} vertical={false} />
          <XAxis dataKey="label" {...axis} />
          <YAxis tickFormatter={(v: number) => `$${v}`} {...axis} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v, name) => [usd(Number(v)), name === "expected" ? "Expected" : "Realized"]}
          />
          <Bar dataKey="expected" fill="var(--accent)" opacity={0.5} />
          <Bar dataKey="realized" fill="var(--positive)" />
        </BarChart>
      </ChartCard>
    </div>
  );
}
