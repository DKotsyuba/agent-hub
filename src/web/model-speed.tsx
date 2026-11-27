/** Model speed filters, summary and on-demand model-wide trends. */
import { Fragment, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import type { ModelSeries, ModelStats, Observation, SpeedDistribution } from '@agent-hub/domain';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { activateRecordRow, Choice, Panel } from '../components/hub-primitives';
import { client, useRead } from './data';
import { ReadState, useWebText } from './ui';

/** Renders the median and central 80% against a shared scale for the column. */
function Range({ value, scale, format, estimated }: { value: SpeedDistribution; scale: number; format: (value: number | null) => string; estimated?: boolean }) {
  const { median, p10, p90 } = value;
  return <div className="speed-range">
    <strong title={estimated ? 'estimated from paired request and completion times' : undefined}>{estimated ? '≈' : ''}{format(median)}</strong>
    {p10 !== null && p90 !== null && <>
      <span className="speed-track" aria-hidden="true"><span style={{ left: p10 / scale * 100 + '%', width: (p90 - p10) / scale * 100 + '%' }} /></span>
      <small title={value.min !== null && value.max !== null ? `min–max ${format(value.min)}–${format(value.max)}` : undefined}>p10–p90 · {format(p10)}–{format(p90)}</small>
    </>}
  </div>;
}

/** Displays a typed observation, keeping missing data distinct from producer failure. */
function SpeedNotice({ outcome }: { outcome?: Observation['outcome'] }) {
  const { label } = useWebText();
  const message = outcome === 'partial' ? 'Agent Stats query too large'
    : outcome === 'invalid' ? 'Agent Stats invalid'
    : outcome === 'incompatible' ? 'Agent Stats incompatible'
    : outcome === 'unavailable' ? 'Agent Stats unavailable' : 'Not enough data yet';
  return <p className={outcome === 'missing' || outcome === 'ok' ? 'web-empty' : 'web-warning'} role="status">{label(message)}</p>;
}

/** Draws one time series, with a break where a bucket has no eligible samples. */
function Sparkline({ series, metric, title }: {
  series: ModelSeries; metric: 'speed_tokens_per_second' | 'ttft_ms'; title: string;
}) {
  const { label, tag, clock } = useWebText();
  const max = Math.max(1, ...series.buckets.map(point => point.metrics[metric].median ?? 0));
  const format = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const points = series.buckets.map((bucket, i) => {
    const value = bucket.metrics[metric].median;
    return value === null ? null : { x: 4 + i * 312 / Math.max(1, series.buckets.length - 1), y: 72 - value / max * 64, value };
  });
  if (!points.some(Boolean)) return <div><strong>{title}</strong><p className="web-muted">{label('Not enough data yet')}</p></div>;
  const time = (index: number) => clock(Number(BigInt(series.buckets[index].start_unix_ns) / 1_000_000n));
  return <figure className="speed-figure">
    <figcaption>{title}</figcaption>
    <svg viewBox="0 0 320 76" role="img" aria-label={title}>
      <path d="M 4 72 H 316" className="speed-baseline" />
      <path className="speed-line" d={points.map((point, i) => point ? (points[i - 1] ? 'L ' : 'M ') + point.x + ' ' + point.y : '').join(' ')} />
      {points.map((point, i) => point && <circle key={series.buckets[i].start_unix_ns} cx={point.x} cy={point.y} r="3">
        <title>{time(i)} · {format.format(point.value)}</title>
      </circle>)}
    </svg>
    <div className="speed-chart-times"><span>{time(0)}</span><span>{time(points.length - 1)}</span></div>
  </figure>;
}

/** Loads the producer's model-wide series for the expanded summary row. */
function Trend({ model, window }: { model: string; window: ModelStats['window'] }) {
  const { label } = useWebText();
  const bucket = window === '24h' ? 'hour' : 'day';
  const read = useRead(JSON.stringify([model, window]), signal => client.get('modelSpeedSeries', { query: { model, bucket, window }, signal }));
  const content = useRef<HTMLDivElement>(null);
  const ready = !read.loading;
  useEffect(() => {
    if (ready && matchMedia('(max-width: 820px)').matches) content.current?.scrollIntoView({ block: 'nearest' });
  }, [ready]);
  return <div ref={content}>
    <h3>{label('Model-wide trend')} · {model}</h3>
    <ReadState read={read}>{({ data, observations }) => data && observations[0]?.outcome === 'ok'
      ? <div className="speed-charts">
        <Sparkline series={data} metric="speed_tokens_per_second" title={label('Speed, tok/s')} />
        <Sparkline series={data} metric="ttft_ms" title={label('TTFT, ms')} />
      </div> : <SpeedNotice outcome={observations[0]?.outcome} />}</ReadState>
  </div>;
}

/** Keeps the column label visible when phone rows stack into cards. */
function MetricCell({ label, children, ...props }: ComponentProps<typeof TableCell> & { label: string }) {
  return <TableCell role="cell" {...props}><span className="speed-mobile-label" aria-hidden="true">{label}</span>{children}</TableCell>;
}

/** Renders grouped calls in descending median speed, with unknown medians last. */
export function ModelSpeedTable({ data }: { data: ModelStats }) {
  const { label, tag } = useWebText();
  const [selected, select] = useState<string | null>(null);
  const trendId = useId();
  const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 1 });
  const format = (value: number | null) => value === null ? '—' : number.format(value);
  const rows = [...data.groups].sort((a, b) =>
    (b.metrics.speed_tokens_per_second.median ?? -Infinity) - (a.metrics.speed_tokens_per_second.median ?? -Infinity));
  const speedScale = Math.max(1, ...rows.map(({ metrics }) => metrics.speed_tokens_per_second.p90 ?? 0));
  const ttftScale = Math.max(1, ...rows.map(({ metrics }) => metrics.ttft_ms.p90 ?? 0));
  return <div className="speed-scroll">
    <Table role="table" className="speed-table" aria-label={label('Model speed')}>
      <TableHeader role="rowgroup"><TableRow role="row">
        <TableHead role="columnheader" scope="col">{label('Model')}</TableHead>
        {data.group_by === 'model+effort' && <TableHead role="columnheader" scope="col">{label('Effort')}</TableHead>}
        <TableHead role="columnheader" scope="col">{label('Provider')}</TableHead>
        <TableHead role="columnheader" scope="col">{label('Calls')}</TableHead>
        <TableHead role="columnheader" scope="col" aria-sort="descending">{label('Speed, tok/s')}</TableHead>
        <TableHead role="columnheader" scope="col">{label('TTFT, ms')}</TableHead>
      </TableRow></TableHeader>
      <TableBody role="rowgroup">{rows.map(({ key, metrics }) => {
        const id = JSON.stringify([key.model, key.provider, key.effort]);
        const expanded = selected === id;
        const toggle = () => select(previous => previous === id ? null : id);
        return <Fragment key={id}>
          <TableRow role="row" data-state={expanded ? 'selected' : undefined} className="speed-row" onClick={event => activateRecordRow(event, toggle)}>
            <th role="rowheader" scope="row"><Button type="button" variant="ghost" aria-expanded={expanded} aria-controls={expanded ? trendId : undefined} onClick={toggle}>{key.model}</Button></th>
            {data.group_by === 'model+effort' && <MetricCell label={label('Effort')}>{key.effort ?? '—'}</MetricCell>}
            <MetricCell label={label('Provider')}>{key.provider ? <Badge variant="outline">{key.provider}</Badge> : '—'}</MetricCell>
            <MetricCell label={label('Calls')}>{format(metrics.count)}</MetricCell>
            <MetricCell label={label('Speed, tok/s')}><Range value={metrics.speed_tokens_per_second} scale={speedScale} format={format} estimated={metrics.speed_estimated === true} /></MetricCell>
            <MetricCell label={label('TTFT, ms')}><Range value={metrics.ttft_ms} scale={ttftScale} format={format} /></MetricCell>
          </TableRow>
          {expanded && <TableRow role="row" className="speed-trend-row"><TableCell role="cell" colSpan={data.group_by === 'model+effort' ? 6 : 5}>
            <div id={trendId} className="speed-trend"><Trend model={key.model} window={data.window} /></div>
          </TableCell></TableRow>}
        </Fragment>;
      })}</TableBody>
    </Table>
  </div>;
}

/** Owns filters and reads the selected summary while the page is visible. */
export function ModelSpeed() {
  const { label } = useWebText();
  const [window, setWindow] = useState('24h');
  const [group_by, setGrouping] = useState('provider+model');
  const key = JSON.stringify([window, group_by]);
  const read = useRead(key, signal => client.get('modelSpeed', { query: { window, group_by }, signal }));
  return <Panel title={label('Models')} className="speed-panel">
    <div className="web-panel-body">
      <div className="speed-filters">
        <div className="speed-filter"><span>{label('Period filter')}</span><Choice label={label('Period filter')} value={window} options={[
          ['24h', label('24 hours')], ['7d', label('7 days')], ['30d', label('30 days')],
        ]} onChange={setWindow} /></div>
        <div className="speed-filter"><span>{label('Grouping')}</span><Choice label={label('Grouping')} value={group_by} options={[
          ['model', label('Model')], ['provider+model', label('Provider + model')], ['model+effort', label('Model + effort')],
        ]} onChange={setGrouping} /></div>
      </div>
      <ReadState read={read}>{({ data, observations }) => data && observations[0]?.outcome === 'ok'
        ? <ModelSpeedTable key={key} data={data} /> : <SpeedNotice outcome={observations[0]?.outcome} />}</ReadState>
    </div>
  </Panel>;
}
