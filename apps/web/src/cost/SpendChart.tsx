import { Box, Paper, Typography } from '@mui/material';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import type { SpendRow } from './api';
import { PURPOSE_LABELS, presentPurposes, spendRows, type Purpose } from './chartData';
import { useChartPalette } from './palette';

const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const shortDay = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`));
export const usd = (value: number, digits = 4) => `$${value.toFixed(digits)}`;

function SpendTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) {
    return null;
  }
  const total = payload.reduce((sum, p) => sum + Number(p.value ?? 0), 0);
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {shortDay(String(label))}: {usd(total)}
      </Typography>
      {[...payload].reverse().map((p) => (
        <Box key={String(p.dataKey)} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: p.color }} />
          <Typography variant="caption" color="text.secondary">
            {PURPOSE_LABELS[p.dataKey as Purpose]} {usd(Number(p.value))}
          </Typography>
        </Box>
      ))}
    </Paper>
  );
}

/** Daily ledger spend, stacked by purpose (Bratislava days). */
export function SpendChart({ rows, from, to }: { rows: SpendRow[]; from: string; to: string }) {
  const palette = useChartPalette();
  const purposes = presentPurposes(rows);
  const data = spendRows(rows, from, to);
  return (
    <Box sx={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} stroke={palette.grid} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={{ fill: palette.axis, fontSize: 12 }}
            stroke={palette.grid}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v.toFixed(v >= 0.01 ? 2 : 3)}`}
            tick={{ fill: palette.axis, fontSize: 12 }}
            stroke="none"
            width={56}
          />
          <Tooltip content={SpendTooltip} cursor={{ fill: palette.grid, opacity: 0.4 }} />
          {purposes.length > 1 && (
            <Legend
              formatter={(value: string) => (
                <Typography component="span" variant="caption" color="text.primary">
                  {PURPOSE_LABELS[value as Purpose]}
                </Typography>
              )}
            />
          )}
          {purposes.map((p, i) => (
            <Bar
              key={p}
              dataKey={p}
              stackId="spend"
              fill={palette.purpose(p)}
              stroke={palette.surface}
              strokeWidth={1}
              radius={i === purposes.length - 1 ? [4, 4, 0, 0] : 0}
              maxBarSize={28}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
