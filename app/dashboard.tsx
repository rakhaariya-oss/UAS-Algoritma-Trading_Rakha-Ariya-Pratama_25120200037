'use client';

import { useEffect, useState } from 'react';
import {
  calculatePerformanceMetrics,
  isPerformanceReport,
  type PerformanceMetrics,
  type PerformanceReport
} from '@/lib/dashboard-metrics';

type DashboardSnapshot = {
  ok: boolean;
  message?: string;
  storageMode: 'persistent' | 'memory' | 'browser';
  hasRun: boolean;
  capital: number;
  equity: number | null;
  dailyPnL: number | null;
  positions: Array<Record<string, any>>;
  killSwitch: boolean | null;
  lastRunAt: number | null;
  risk: { maxPositions: number; maxPositionSize: number; dailyLossLimit: number };
  universe: Array<{ pair: string; signal: string | null; lastRunAt: string | null; validation: string; candlesCount: number | null }>;
  forwardMetrics: PerformanceMetrics | null;
  logs: Array<Record<string, any>>;
  generatedAt: string;
};

type ReportSet = Partial<Record<'backtest' | 'forward_test', PerformanceReport>>;
type Tab = 'overview' | 'performance' | 'trades' | 'activity';
const REQUIRED_FREEZE_AT = '2026-11-04T05:00:00.000Z';

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Ringkasan' },
  { id: 'performance', label: 'Performa' },
  { id: 'trades', label: 'Trade' },
  { id: 'activity', label: 'Aktivitas' }
];

const formatMoney = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? '--'
  : new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value);

const formatPercent = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value)
  ? '--'
  : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

const formatDate = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '--';
  const date = new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('id-ID');
};

const describeEvent = (entry: Record<string, any>) => {
  if (entry.type === 'validation_error') return 'Validasi data menolak tick';
  if (entry.type === 'trade_closed') return 'Trade ditutup';
  if (entry.orderResult?.status === 'FILLED') return `Simulasi ${entry.orderResult.side} terisi`;
  if (entry.type === 'tick_run') return `Tick ${entry.signal ?? 'HOLD'}`;
  return String(entry.type ?? 'Event bot');
};

function MetricCard({ label, value, detail, tone = 'default' }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function EquityChart({ report }: { report?: PerformanceReport }) {
  const points = (report?.equityCurve ?? []).filter((point) => Number.isFinite(Number(point.equity)));
  if (points.length < 2) {
    return <div className="empty-chart">Kurva equity tampil setelah laporan berisi minimal dua snapshot equity.</div>;
  }

  const values = points.map((point) => Number(point.equity));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const coordinates = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 1000;
    const y = 160 - ((value - min) / spread) * 130;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg className="equity-chart" viewBox="0 0 1000 180" role="img" aria-label="Kurva equity laporan">
      <line x1="0" y1="160" x2="1000" y2="160" className="chart-axis" />
      <polyline points={coordinates} className="chart-line" />
      <text x="0" y="176" className="chart-caption">{formatMoney(min)}</text>
      <text x="1000" y="176" textAnchor="end" className="chart-caption">{formatMoney(max)}</text>
    </svg>
  );
}

function ReportMetrics({ report, label }: { report?: PerformanceReport; label: string }) {
  const metrics = report ? calculatePerformanceMetrics(report) : null;
  if (!report || !metrics) {
    return (
      <section className="report-card report-empty">
        <div className="section-heading"><div><p className="eyebrow">{label}</p><h3>Belum ada laporan</h3></div></div>
        <p>{label.toLowerCase().includes('forward') ? 'Belum ada transaksi forward test yang tercatat untuk periode ini.' : 'Laporan backtest belum tersedia pada deployment ini.'}</p>
      </section>
    );
  }

  return (
    <section className="report-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{label}</p>
          <h3>{formatPercent(metrics.totalReturnPercent)}</h3>
          {report.source && <small className="report-source">{report.source}</small>}
          {report.mode === 'backtest' && report.endAt !== REQUIRED_FREEZE_AT && <small className="report-source">Freeze report tidak cocok dengan tugas. Target: {formatDate(REQUIRED_FREEZE_AT)} · report: {formatDate(report.endAt)}</small>}
          {report.provenance === 'historical_replay' && <small className="report-source">Log eksekusi live tidak tercatat untuk periode ini; hasil menggunakan replay candle historis, bukan forward test live · data tersedia sampai {formatDate(report.dataThrough)} · {report.complete ? 'periode lengkap' : `belum mencapai ${formatDate(report.requestedEndAt)}`}</small>}
          {report.mode === 'forward_test' && !report.provenance && <small className="report-source">Report lama tanpa arsip candle/provenance; bukan bukti log eksekusi live.</small>}
          {report.assumptions && <small className="report-source">Next candle open · fee {(Number(report.assumptions.feeRatePerSide) * 100).toFixed(2)}%/side · slippage {(Number(report.assumptions.slippageRatePerSide) * 100).toFixed(2)}%/side · historical spread unavailable</small>}
        </div>
        <span className="trade-count">{metrics.tradeCount} trade</span>
      </div>
      <dl className="metric-list">
        <div><dt>Max drawdown</dt><dd>{formatPercent(metrics.maxDrawdownPercent)}</dd></div>
        {report.mode === 'backtest' && <div><dt>CAGR</dt><dd>{formatPercent(metrics.cagrPercent)}</dd></div>}
        <div><dt>Profit factor</dt><dd>{metrics.profitFactor === null ? '--' : metrics.profitFactor.toFixed(2)}</dd></div>
        <div><dt>Win rate</dt><dd>{formatPercent(metrics.winRatePercent)}</dd></div>
        <div><dt>Rata-rata untung</dt><dd>{formatMoney(metrics.averageWin)}</dd></div>
        <div><dt>Rata-rata rugi</dt><dd>{formatMoney(metrics.averageLoss)}</dd></div>
        <div><dt>Biaya total</dt><dd>{formatMoney(metrics.fees + metrics.spreadCost + metrics.slippageCost)}</dd></div>
        <div><dt>Biaya / laba kotor</dt><dd>{formatPercent(metrics.costsAsPercentOfGrossProfit)}</dd></div>
        <div><dt>Buy & hold BTC/IDR</dt><dd>{formatPercent(metrics.benchmarkReturnPercent)}</dd></div>
        <div><dt>Gap vs benchmark</dt><dd>{formatPercent(metrics.gapVsBenchmarkPercent)}</dd></div>
      </dl>
    </section>
  );
}

export default function Dashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [reports, setReports] = useState<ReportSet>({});
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [apiError, setApiError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadReport = async (url: string, mode: PerformanceReport['mode']) => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return null;
        const report = await response.json();
        return isPerformanceReport(report) && report.mode === mode ? report : null;
      } catch {
        return null;
      }
    };
    Promise.all([
      loadReport('/data/backtest.json', 'backtest'),
      loadReport('/data/forward-test.json', 'forward_test')
    ]).then(([backtest, forward_test]) => {
      if (cancelled) return;
      setReports((current) => ({ ...current, backtest: backtest ?? undefined, forward_test: forward_test ?? undefined }));
    });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/dashboard', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.message ?? 'Dashboard API tidak tersedia');
        if (!cancelled) {
          setSnapshot(data);
          setApiError('');
        }
      } catch (error) {
        if (!cancelled) setApiError(error instanceof Error ? error.message : 'Dashboard API tidak tersedia');
      }
    };

    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const logs = snapshot?.logs ?? [];
  const tradeEvents = logs.filter((entry) => entry.type === 'trade_closed' || entry.orderResult);
  const riskBlocked = snapshot?.dailyPnL !== null && snapshot?.dailyPnL !== undefined
    && snapshot.dailyPnL <= -Math.abs(snapshot.risk.dailyLossLimit);
  const riskLabel = snapshot?.killSwitch === true ? 'Kill switch aktif'
    : riskBlocked ? 'Batas rugi tercapai'
      : snapshot?.hasRun ? 'Risk gate normal' : 'Menunggu tick pertama';
  const backtestMetrics = reports.backtest ? calculatePerformanceMetrics(reports.backtest) : null;
  const forwardMetrics = reports.forward_test ? calculatePerformanceMetrics(reports.forward_test) : snapshot?.forwardMetrics;
  const gap = backtestMetrics?.totalReturnPercent !== null && backtestMetrics?.totalReturnPercent !== undefined
    && forwardMetrics?.totalReturnPercent !== null && forwardMetrics?.totalReturnPercent !== undefined
    ? forwardMetrics.totalReturnPercent - backtestMetrics.totalReturnPercent
    : null;

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Indodax Dry Run dashboard">
          <img className="brand-logo" src="/logo-cakrawala-doang-v2.webp" alt="Logo Cakrawala" />
          <strong className="student-identity">Rakha Ariya Pratama - 25120200037</strong>
        </a>
        <div className="header-actions">
          <strong className="project-title">Indodax Dry Run</strong>
          <span className={`connection-state ${apiError ? 'is-error' : snapshot?.hasRun ? 'is-live' : 'is-idle'}`}>
            <i />{apiError ? 'API terputus' : snapshot?.hasRun ? 'Paper engine aktif' : 'Belum ada tick'}
          </span>
        </div>
      </header>

      <section className="page-intro">
        <div><p className="eyebrow">Paper trading / dry run</p><h1>Bot Control Room</h1><p className="intro-copy">Pantau eksekusi simulasi, performa strategi, dan batas risiko dari log yang tercatat.</p></div>
        <div className="run-meta"><span>Tick terakhir</span><strong>{snapshot?.lastRunAt ? formatDate(snapshot.lastRunAt) : '--'}</strong></div>
      </section>

      <nav className="tabs" aria-label="Dashboard sections">
        {tabs.map((tab) => <button key={tab.id} type="button" className={activeTab === tab.id ? 'tab is-active' : 'tab'} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
      </nav>

      {apiError && <div className="notice notice-error" role="status">Data runtime belum dapat dimuat: {apiError}. Panel laporan tetap dapat digunakan.</div>}
      {snapshot?.storageMode === 'memory' && <div className="notice" role="status">Storage persisten belum terpasang. Log pada deployment ini dapat hilang atau berbeda antar-instance; hubungkan Vercel KV/Upstash sebelum forward test.</div>}

      {activeTab === 'overview' && (
        <>
          <section className="metric-grid" aria-label="Portfolio overview">
            <MetricCard label="Modal awal" value={formatMoney(snapshot?.capital)} detail="Modal virtual konfigurasi" />
            <MetricCard label="Equity" value={formatMoney(snapshot?.equity)} detail={snapshot?.hasRun ? 'Dari state terakhir bot' : 'Menunggu data bot'} tone="green" />
            <MetricCard label="Daily PnL" value={formatMoney(snapshot?.dailyPnL)} detail={snapshot?.lastRunAt ? `Per ${formatDate(snapshot.lastRunAt)}` : 'Belum ada perhitungan'} tone={snapshot?.dailyPnL && snapshot.dailyPnL < 0 ? 'red' : 'default'} />
            <MetricCard label="Posisi terbuka" value={snapshot ? String(snapshot.positions.length) : '--'} detail={`Maksimum ${snapshot?.risk.maxPositions ?? '--'} posisi`} />
            <MetricCard label="CAGR backtest" value={formatPercent(backtestMetrics?.cagrPercent)} detail="Return tahunan majemuk · 3 tahun" tone="green" />
          </section>

          <section className="overview-grid">
            <div className="panel performance-panel">
              <div className="section-heading"><div><p className="eyebrow">Perbandingan periode</p><h2>Backtest vs forward test</h2></div><button className="text-button" type="button" onClick={() => setActiveTab('performance')}>Lihat metrik</button></div>
              <div className="comparison-grid"><ReportMetrics report={reports.backtest} label="Backtest 3 tahun" /><ReportMetrics report={reports.forward_test} label="Forward test 10 hari" /></div>
              <div className="gap-row"><span>Gap return forward vs backtest</span><strong>{formatPercent(gap)}</strong></div>
            </div>

            <aside className="panel risk-panel">
              <div className="section-heading"><div><p className="eyebrow">Pengawasan</p><h2>Status risiko</h2></div></div>
              <div className="risk-status"><span className={snapshot?.killSwitch || riskBlocked ? 'risk-indicator is-danger' : snapshot?.hasRun ? 'risk-indicator is-ok' : 'risk-indicator is-idle'} /> <strong>{riskLabel}</strong></div>
              <dl className="risk-list">
                <div><dt>Kill switch</dt><dd>{snapshot?.killSwitch === null || snapshot?.killSwitch === undefined ? 'Belum diketahui' : snapshot.killSwitch ? 'AKTIF' : 'Nonaktif'}</dd></div>
                <div><dt>Daily loss limit</dt><dd>{formatMoney(snapshot?.risk.dailyLossLimit)}</dd></div>
                <div><dt>Ukuran posisi maks.</dt><dd>{formatMoney(snapshot?.risk.maxPositionSize)}</dd></div>
                <div><dt>Validasi terakhir</dt><dd>{logs.some((entry) => entry.type === 'validation_error') ? 'Ada penolakan' : snapshot?.hasRun ? 'Tidak ada error tercatat' : '--'}</dd></div>
              </dl>
            </aside>
          </section>

          <section className="panel universe-panel">
            <div className="section-heading"><div><p className="eyebrow">Watchlist strategi</p><h2>Universe dan sinyal terakhir</h2></div><span className="count-tag">{snapshot?.universe.length ?? 7} pair</span></div>
            {snapshot?.universe.length ? <div className="table-wrap"><table><thead><tr><th>Pair</th><th>Sinyal strategi</th><th>Candle dianalisis</th><th>Validasi</th><th>Tick terakhir</th></tr></thead><tbody>{snapshot.universe.map((item) => <tr key={item.pair}><td>{item.pair}</td><td><span className={`signal signal-${String(item.signal ?? 'hold').toLowerCase()}`}>{item.signal ?? 'MENUNGGU'}</span></td><td>{item.candlesCount ?? '--'}</td><td>{item.validation === 'ok' ? 'VALID' : item.validation === 'rejected' ? 'DITOLAK' : 'BELUM ADA TICK'}</td><td>{formatDate(item.lastRunAt)}</td></tr>)}</tbody></table></div> : <div className="empty-state">Menunggu data runtime.</div>}
          </section>

          <section className="bottom-grid">
            <div className="panel">
              <div className="section-heading"><div><p className="eyebrow">Eksposur</p><h2>Posisi terbuka</h2></div><span className="count-tag">{snapshot?.positions.length ?? 0}</span></div>
              {snapshot?.positions.length ? (
                <div className="table-wrap"><table><thead><tr><th>Pair</th><th>Kuantitas</th><th>Harga rata-rata</th><th>Nilai IDR</th></tr></thead><tbody>{snapshot.positions.map((position, index) => <tr key={`${position.pair}-${index}`}><td>{position.pair ?? '--'}</td><td>{Number(position.quantity ?? 0).toLocaleString('id-ID')}</td><td>{formatMoney(position.avgPrice)}</td><td>{formatMoney(position.valueIdr)}</td></tr>)}</tbody></table></div>
              ) : <div className="empty-state">Belum ada posisi dari log bot.</div>}
            </div>
            <div className="panel">
              <div className="section-heading"><div><p className="eyebrow">Jejak terbaru</p><h2>Aktivitas bot</h2></div><button className="text-button" type="button" onClick={() => setActiveTab('activity')}>Semua log</button></div>
              <ActivityList logs={logs.slice(0, 5)} />
            </div>
          </section>
        </>
      )}

      {activeTab === 'performance' && (
        <>
          <section className="comparison-grid performance-reports"><ReportMetrics report={reports.backtest} label="Backtest 3 tahun" /><ReportMetrics report={reports.forward_test} label="Forward test 10 hari" /></section>
          <section className="panel chart-panel"><div className="section-heading"><div><p className="eyebrow">Equity curve</p><h2>Backtest</h2></div></div><EquityChart report={reports.backtest} /></section>
          <section className="panel chart-panel"><div className="section-heading"><div><p className="eyebrow">Equity curve</p><h2>Forward test</h2></div></div><EquityChart report={reports.forward_test} /></section>
        </>
      )}

      {activeTab === 'trades' && (
        <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">Simulated execution</p><h2>Trade dan order</h2></div><span className="count-tag">{tradeEvents.length}</span></div>
          {tradeEvents.length ? <div className="table-wrap"><table><thead><tr><th>Waktu</th><th>Pair</th><th>Sinyal</th><th>Eksekusi</th><th>Kuantitas</th><th>Harga rata-rata</th><th>Fee</th></tr></thead><tbody>{tradeEvents.map((entry, index) => { const order = entry.orderResult ?? entry; return <tr key={`${entry.timestamp}-${index}`}><td>{formatDate(entry.timestamp)}</td><td>{entry.pair ?? order.pair ?? '--'}</td><td><span className={`signal signal-${String(entry.signal ?? order.side ?? 'hold').toLowerCase()}`}>{entry.signal ?? order.side ?? '--'}</span></td><td>{order.status ?? (entry.type === 'trade_closed' ? 'CLOSED' : '--')}</td><td>{Number(order.quantity ?? 0).toLocaleString('id-ID')}</td><td>{formatMoney(order.avgPrice)}</td><td>{formatMoney(order.fee)}</td></tr>; })}</tbody></table></div> : <div className="empty-state">Belum ada order simulasi pada log. Tick tanpa order tetap bisa dilihat di tab Aktivitas.</div>}
        </section>
      )}

      {activeTab === 'activity' && (
        <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">Event stream</p><h2>Log bot</h2></div><span className="count-tag">{logs.length}</span></div>
          <ActivityList logs={logs} detailed />
        </section>
      )}

      <footer className="dashboard-footer"><span>Dry-run only · Tidak mengirim order ke exchange</span><span>{snapshot?.generatedAt ? `Data diperbarui ${formatDate(snapshot.generatedAt)}` : 'Menunggu koneksi API'} · Auto-refresh 15 detik</span></footer>
    </main>
  );
}

function ActivityList({ logs, detailed = false }: { logs: Array<Record<string, any>>; detailed?: boolean }) {
  if (!logs.length) return <div className="empty-state">Belum ada event bot.</div>;
  return (
    <ol className="activity-list">
      {logs.map((entry, index) => (
        <li key={`${entry.timestamp}-${index}`}>
          <span className={`event-marker ${entry.type === 'validation_error' ? 'is-error' : entry.orderResult?.status === 'FILLED' ? 'is-trade' : ''}`} />
          <div className="event-copy"><strong>{describeEvent(entry)}</strong><small>{entry.pair ?? '--'}{entry.signal ? ` · ${entry.signal}` : ''}{detailed && entry.issues?.length ? ` · ${entry.issues.map((issue: any) => issue.message ?? issue).join('; ')}` : ''}</small></div>
          <time>{formatDate(entry.timestamp)}</time>
        </li>
      ))}
    </ol>
  );
}
