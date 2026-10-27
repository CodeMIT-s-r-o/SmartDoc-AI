import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { type Feedback, getFeedback, getMetrics, lastDays, type Metrics } from './api';
import { PURPOSE_LABELS, presentPurposes, type WaterfallStep } from './chartData';
import { ReplayWaterfall } from './ReplayWaterfall';
import replay from './replay.json';
import { SpendChart, usd } from './SpendChart';

const RANGES = [7, 30, 90] as const;
const percent = (share: number) => `${(share * 100).toFixed(1)} %`;
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {subtitle}
          </Typography>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h5" component="p" sx={{ my: 0.5 }}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </CardContent>
    </Card>
  );
}

function Tiles({ metrics }: { metrics: Metrics }) {
  const { requests, promptCache, savings } = metrics;
  const saved = savings.reduce((sum, s) => sum + s.savedUsd, 0);
  return (
    <Box
      sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' } }}
    >
      <Tile
        label="Cost per answer (p50)"
        value={usd(requests.answeredP50Usd, 5)}
        hint={`${requests.answered} answered of ${requests.total} requests`}
      />
      <Tile
        label="Exact cache hits"
        value={percent(requests.exactCacheHitRate)}
        hint={`${requests.exactCacheHits} answers served for $0`}
      />
      <Tile
        label="Prompt cache share"
        value={percent(promptCache.cachedShare)}
        hint="of chat input tokens read from cache"
      />
      <Tile
        label="Saved"
        value={usd(saved, 4)}
        hint={`booked by the cache and the gate; spent ${usd(requests.totalUsd, 4)}`}
      />
    </Box>
  );
}

function PurposeTable({ metrics }: { metrics: Metrics }) {
  const totals = presentPurposes(metrics.spendByDay).map((purpose) => {
    const rows = metrics.spendByDay.filter((r) => r.purpose === purpose);
    return {
      purpose,
      calls: rows.reduce((s, r) => s + r.calls, 0),
      costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    };
  });
  return (
    <Table size="small" aria-label="Spend by purpose" sx={{ mt: 2 }}>
      <TableHead>
        <TableRow>
          <TableCell>Purpose</TableCell>
          <TableCell align="right">Calls</TableCell>
          <TableCell align="right">Cost</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {totals.map((t) => (
          <TableRow key={t.purpose}>
            <TableCell>{PURPOSE_LABELS[t.purpose]}</TableCell>
            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {t.calls}
            </TableCell>
            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {usd(t.costUsd, 5)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReplaySection() {
  return (
    <Section
      title="Where the savings come from"
      subtitle={`${replay.label}: the same ${replay.requestsPerArm} questions (${replay.repeats} of them repeats) through three configurations, costs from the ledger. Commit ${replay.gitSha}.`}
    >
      <ReplayWaterfall steps={replay.waterfall as WaterfallStep[]} />
      <Table size="small" aria-label="Replay arms" sx={{ mt: 2 }}>
        <TableHead>
          <TableRow>
            <TableCell>Configuration</TableCell>
            <TableCell align="right">$ / 1k queries</TableCell>
            <TableCell align="right">Prompt cache</TableCell>
            <TableCell align="right">Latency p50</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {replay.arms.map((arm) => (
            <TableRow key={arm.arm}>
              <TableCell sx={{ textTransform: 'capitalize' }}>{arm.arm}</TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                ${arm.costPer1kUsd.toFixed(2)}
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {percent(arm.promptCacheShare)}
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {(arm.latencyP50Ms / 1000).toFixed(1)} s
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function ThumbsDownTable({ feedback }: { feedback: Feedback }) {
  if (feedback.items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No thumbs-downs yet.
      </Typography>
    );
  }
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Thumbs-down answers">
        <TableHead>
          <TableRow>
            <TableCell>When</TableCell>
            <TableCell>Question and answer</TableCell>
            <TableCell>Reasons</TableCell>
            <TableCell align="right">Cost</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {feedback.items.map((item) => (
            <TableRow key={item.messageId} sx={{ verticalAlign: 'top' }}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {dateTime.format(new Date(item.createdAt))}
              </TableCell>
              <TableCell sx={{ minWidth: 280 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {item.question ?? '(question not found)'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {item.answer}
                </Typography>
                {item.comment && (
                  <Typography variant="body2" sx={{ mt: 0.5, fontStyle: 'italic' }}>
                    “{item.comment}”
                  </Typography>
                )}
                {item.requestId && (
                  <Typography variant="caption" color="text.secondary">
                    request {item.requestId}
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                  {item.reasons.map((reason) => (
                    <Chip key={reason} size="small" label={reason.replaceAll('_', ' ')} />
                  ))}
                </Stack>
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {item.costUsd === null ? '–' : usd(item.costUsd, 5)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

/** Admin-only: what the app costs, where the savings come from, and what users disliked. */
export function CostPage({ accessToken, onBack }: { accessToken: string; onBack: () => void }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const range = lastDays(days);
  const metrics = useQuery({
    queryKey: ['admin', 'metrics', range],
    queryFn: () => getMetrics(accessToken, range),
  });
  const feedback = useQuery({
    queryKey: ['admin', 'feedback'],
    queryFn: () => getFeedback(accessToken),
  });

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Button startIcon={<ArrowBackIcon />} onClick={onBack}>
          Chat
        </Button>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
          Cost
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={days}
          onChange={(_, value: (typeof RANGES)[number] | null) => value && setDays(value)}
          aria-label="Date range"
        >
          {RANGES.map((d) => (
            <ToggleButton key={d} value={d}>
              {d} days
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>

      {metrics.isError && <Alert severity="error">{metrics.error.message}</Alert>}
      {metrics.isPending && <CircularProgress aria-label="Loading metrics" sx={{ mx: 'auto' }} />}
      {metrics.data && (
        <>
          <Tiles metrics={metrics.data} />
          <Section
            title="Spend per day"
            subtitle="Every OpenAI call from the ledger, by what it was for (days in Europe/Bratislava)."
          >
            {metrics.data.spendByDay.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No calls in this range.
              </Typography>
            ) : (
              <>
                <SpendChart rows={metrics.data.spendByDay} from={range.from} to={range.to} />
                <PurposeTable metrics={metrics.data} />
              </>
            )}
          </Section>
        </>
      )}

      <ReplaySection />

      <Section
        title="Thumbs-down answers"
        subtitle={
          feedback.data
            ? `${feedback.data.down} down and ${feedback.data.up} up in total; the newest 50 below.`
            : undefined
        }
      >
        {feedback.isError && <Alert severity="error">{feedback.error.message}</Alert>}
        {feedback.data && <ThumbsDownTable feedback={feedback.data} />}
      </Section>
    </Stack>
  );
}
