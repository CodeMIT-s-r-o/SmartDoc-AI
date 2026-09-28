import { createTheme } from '@mui/material/styles';

/** Material Design with light and dark schemes, following the operating system setting. */
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#3f51b5' },
        secondary: { main: '#00897b' },
        background: { default: '#f5f6fa', paper: '#ffffff' },
      },
    },
    dark: {
      palette: {
        primary: { main: '#8c9eff' },
        secondary: { main: '#4db6ac' },
        background: { default: '#101218', paper: '#181b23' },
      },
    },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Roboto, system-ui, -apple-system, "Segoe UI", sans-serif',
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } },
    },
    MuiCard: { defaultProps: { variant: 'outlined' } },
    MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});
