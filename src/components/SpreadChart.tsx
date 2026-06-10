"use client";

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpreadPoint } from "@/lib/queries";

export function SpreadChart({ points }: { points: SpreadPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="py-8 text-center text-xs text-muted">
        Not enough price history yet — snapshots accumulate every few minutes.
      </p>
    );
  }

  const data = points.map((p) => ({
    ts: new Date(p.ts).getTime(),
    kalshi: p.kalshi === null ? null : Math.round(p.kalshi * 100),
    polymarket: p.polymarket === null ? null : Math.round(p.polymarket * 100),
  }));

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t: number) =>
              new Date(t).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })
            }
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            opacity={0.5}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}¢`}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            opacity={0.5}
          />
          <Tooltip
            labelFormatter={(t) =>
              new Date(Number(t)).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            }
            formatter={(value) => [`${value}¢`]}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="kalshi"
            name="Kalshi"
            stroke="var(--positive)"
            dot={false}
            strokeWidth={2}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="polymarket"
            name="Polymarket"
            stroke="var(--accent)"
            dot={false}
            strokeWidth={2}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
