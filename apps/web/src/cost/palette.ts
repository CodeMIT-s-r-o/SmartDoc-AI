import { useColorScheme } from '@mui/material';
import type { Purpose } from './chartData';

/**
 * Chart colors (the dataviz reference palette): categorical slots in a fixed order, stepped
 * separately for the dark surface, plus recessive chrome. Purposes map to slots by identity.
 */
const LIGHT = {
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  grid: '#e1e0d9',
  axis: '#898781',
  surface: '#ffffff',
};
const DARK = {
  series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
  grid: '#2c2c2a',
  axis: '#898781',
  surface: '#181b23',
};

const SLOT: Record<Purpose, number> = {
  chat: 0,
  rewrite: 1,
  query_embed: 2,
  doc_embed: 3,
  judge: 4,
  eval: 5,
};

export function useChartPalette() {
  const { mode, systemMode } = useColorScheme();
  const colors = (mode === 'system' ? systemMode : mode) === 'dark' ? DARK : LIGHT;
  return {
    ...colors,
    purpose: (p: Purpose) => colors.series[SLOT[p]],
    /** Waterfall: totals blue, savings aqua, added cost orange. */
    total: colors.series[0],
    saving: colors.series[2],
    cost: colors.series[1],
  };
}
