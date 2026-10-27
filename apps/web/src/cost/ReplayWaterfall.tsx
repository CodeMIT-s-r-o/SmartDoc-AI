import { Box, Paper, Typography } from '@mui/material';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { type WaterfallBar, type WaterfallStep, waterfallBars } from './chartData';
import { useChartPalette } from './palette';

const per1k = (v: number) => `$${v.toFixed(2)}`;
const signed = (bar: WaterfallBar) =>
  bar.kind === 'total' ? per1k(bar.usdPer1k) : `${bar.usdPer1k < 0 ? '−' : '+'}${per1k(bar.size)}`;

function StepTooltip({ active, payload }: TooltipContentProps<ValueType, NameType>) {
  const bar = payload?.[0]?.payload as WaterfallBar | undefined;
  if (!active || !bar) {
    return null;
  }
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {bar.label}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {bar.kind === 'total'
          ? `${per1k(bar.usdPer1k)} per 1,000 queries`
          : `${signed(bar)} per 1,000 queries`}
      </Typography>
    </Paper>
  );
}

/** Naive → optimized in USD per 1,000 queries; each step is one mechanism. */
export function ReplayWaterfall({ steps }: { steps: WaterfallStep[] }) {
  const palette = useChartPalette();
  const bars = waterfallBars(steps);
  const color = (bar: WaterfallBar) =>
    bar.effect === 'total'
      ? palette.total
      : bar.effect === 'saving'
        ? palette.saving
        : palette.cost;
  return (
    <Box sx={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} margin={{ top: 24, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke={palette.grid} />
          <XAxis
            dataKey="label"
            interval={0}
            tick={{ fill: palette.axis, fontSize: 11 }}
            stroke={palette.grid}
            height={40}
          />
          <YAxis
            tickFormatter={per1k}
            tick={{ fill: palette.axis, fontSize: 12 }}
            stroke="none"
            width={48}
          />
          <Tooltip content={StepTooltip} cursor={{ fill: palette.grid, opacity: 0.4 }} />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="size" stackId="w" radius={4} maxBarSize={56}>
            {bars.map((bar) => (
              <Cell key={bar.label} fill={color(bar)} />
            ))}
            <LabelList
              dataKey="size"
              position="top"
              content={({ x, y, width, index }) => {
                const bar = index === undefined ? undefined : bars[index];
                return bar === undefined ? null : (
                  <text
                    x={Number(x) + Number(width) / 2}
                    y={Number(y) - 6}
                    textAnchor="middle"
                    fontSize={12}
                    fill="currentColor"
                  >
                    {signed(bar)}
                  </text>
                );
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
