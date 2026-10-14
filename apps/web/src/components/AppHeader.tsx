import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import LogoutIcon from '@mui/icons-material/Logout';
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  ListItemIcon,
  Menu,
  MenuItem,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { Me } from '../api';

const usd = (value: number, digits: number) => `$${value.toFixed(digits)}`;
/** A limit as set: $0.25, but $0.001 rather than a rounded $0.00. */
const limitUsd = (value: number) =>
  value >= 0.01 ? usd(value, 2) : `$${Number(value.toFixed(4)).toString()}`;

function UsageChip({ me }: { me: Me }) {
  const share =
    me.dailyLimitUsd > 0 ? Math.min(100, (me.spentTodayUsd / me.dailyLimitUsd) * 100) : 0;
  return (
    <Tooltip
      title={`Today's AI spend: ${usd(me.spentTodayUsd, 5)} of your ${limitUsd(me.dailyLimitUsd)} daily limit`}
    >
      <Box sx={{ display: { xs: 'none', sm: 'block' }, minWidth: 150 }}>
        <Typography variant="caption" color="text.secondary">
          Today {usd(me.spentTodayUsd, 4)} / {limitUsd(me.dailyLimitUsd)}
        </Typography>
        <LinearProgress
          variant="determinate"
          value={share}
          color={share > 90 ? 'error' : share > 70 ? 'warning' : 'primary'}
          sx={{ height: 4, borderRadius: 2 }}
        />
      </Box>
    </Tooltip>
  );
}

export function AppHeader({ me, onSignOut }: { me: Me | undefined; onSignOut: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <AppBar
      position="sticky"
      color="inherit"
      elevation={0}
      sx={{ borderBottom: 1, borderColor: 'divider' }}
    >
      <Toolbar sx={{ gap: 2 }}>
        <AutoStoriesIcon color="primary" />
        <Typography variant="h6" component="span" sx={{ flexGrow: 1 }}>
          SmartDoc AI
        </Typography>
        {me && <UsageChip me={me} />}
        <Tooltip title="Account">
          <IconButton aria-label="Account menu" onClick={(e) => setAnchor(e.currentTarget)}>
            <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 15 }}>
              {me?.email.charAt(0).toUpperCase() ?? '?'}
            </Avatar>
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={anchor}
          open={Boolean(anchor)}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {me?.email}
            </Typography>
            <Chip
              size="small"
              label={me?.isAdmin ? 'Admin' : 'Member'}
              color={me?.isAdmin ? 'secondary' : 'default'}
              sx={{ mt: 0.5 }}
            />
          </Box>
          <Divider />
          <MenuItem onClick={onSignOut}>
            <ListItemIcon>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
}
