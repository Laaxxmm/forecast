import { useEffect, useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import api from '../../api/client';
import { formatINR, formatNumber } from '../../utils/format';
import { Users, Stethoscope, FlaskConical, Activity, ArrowRight, Search, ChevronLeft, ChevronRight } from 'lucide-react';

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];
const CHART_STYLE = { backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '12px' };

interface ClinicAnalyticsProps {
  isVisible: (key: string) => boolean;
}

export default function ClinicAnalytics({ isVisible }: ClinicAnalyticsProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    api.get('/dashboard/clinic-analytics').then(res => {
      setData(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const patientTable = data?.patientTable || [];
  const filteredPatients = useMemo(() => {
    if (!search) return patientTable;
    const s = search.toLowerCase();
    return patientTable.filter((p: any) =>
      (p.patient_name || '').toLowerCase().includes(s) ||
      (p.patient_id || '').toLowerCase().includes(s)
    );
  }, [patientTable, search]);

  if (loading) return (
    <div className="text-center py-8">
      <div className="w-6 h-6 border-2 border-teal-500/30 border-t-teal-500 rounded-full animate-spin mx-auto" />
    </div>
  );

  if (!data?.hasData) return null;

  const { kpi, departmentOverlap, combinations, revenueByDeptCount, patientFlow, crossSellFunnel, doctorCrossSell } = data;

  const anyCardVisible = ['total_unique_patients', 'appointment_patients', 'lab_test_patients', 'other_services_patients', 'direct_lab_walkins', 'direct_other_walkins'].some(isVisible);
  const anyChartVisible = ['department_overlap', 'patient_dept_donut', 'dept_combination_bars', 'revenue_per_patient', 'patient_flow_sankey', 'cross_sell_funnel', 'doctor_cross_sell_rate', 'doctor_stacked_bar'].some(isVisible);
  const tableVisible = isVisible('patient_summary_table');

  if (!anyCardVisible && !anyChartVisible && !tableVisible) return null;

  // Prepare chart data
  const overlapData = [
    { name: '1 Department', count: departmentOverlap.in1 },
    { name: '2 Departments', count: departmentOverlap.in2 },
    { name: '3 Departments', count: departmentOverlap.in3 },
  ];

  const donutData = overlapData.map(d => ({ name: d.name, value: d.count }));

  const comboData = combinations.map((c: any) => ({ name: c.combo, count: c.count }));

  const revCompareData = revenueByDeptCount.map((r: any) => ({
    name: r.deptCount === 1 ? 'Single Dept' : r.deptCount === 2 ? '2 Depts' : '3 Depts',
    avgRevenue: Math.round(r.avgRevenue),
    patients: r.patients,
  }));
  const baseAvg = revCompareData[0]?.avgRevenue || 1;

  const funnelData = [
    { name: 'Total Appointment', value: crossSellFunnel.totalAppointment, pct: 100 },
    { name: 'Cross → Other Services', value: crossSellFunnel.crossToOther, pct: crossSellFunnel.totalAppointment > 0 ? (crossSellFunnel.crossToOther / crossSellFunnel.totalAppointment * 100) : 0 },
    { name: 'Cross → Lab Tests', value: crossSellFunnel.crossToLab, pct: crossSellFunnel.totalAppointment > 0 ? (crossSellFunnel.crossToLab / crossSellFunnel.totalAppointment * 100) : 0 },
    { name: 'Cross → Both', value: crossSellFunnel.crossToBoth, pct: crossSellFunnel.totalAppointment > 0 ? (crossSellFunnel.crossToBoth / crossSellFunnel.totalAppointment * 100) : 0 },
    { name: 'Appointment Only', value: crossSellFunnel.apptOnly, pct: crossSellFunnel.totalAppointment > 0 ? (crossSellFunnel.apptOnly / crossSellFunnel.totalAppointment * 100) : 0 },
  ];

  const doctorStackedData = doctorCrossSell.map((d: any) => ({
    name: d.doctor.length > 15 ? d.doctor.slice(0, 15) + '...' : d.doctor,
    fullName: d.doctor,
    crossSold: d.crossSold,
    apptOnly: d.apptOnly,
    rate: d.crossSellRate,
  }));

  const totalPages = Math.ceil(filteredPatients.length / PAGE_SIZE);
  const pagePatients = filteredPatients.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-6">
        <Stethoscope size={18} className="text-teal-400" />
        <h2 className="text-lg font-bold text-theme-heading">Clinic Analytics</h2>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-400">Healthplix</span>
      </div>

      {/* Section A — Patient Count KPI Cards */}
      {anyCardVisible && (() => {
        const visibleCount = ['total_unique_patients', 'appointment_patients', 'lab_test_patients', 'other_services_patients', 'direct_lab_walkins', 'direct_other_walkins'].filter(isVisible).length;
        const lgColsClass: Record<number, string> = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6' };
        return (
        <div className={`grid grid-cols-2 md:grid-cols-3 ${lgColsClass[visibleCount] || 'lg:grid-cols-6'} gap-4 mb-6`}>
          {isVisible('total_unique_patients') && (
            <MiniKPI label="Total Patients" value={formatNumber(kpi.totalUnique)} icon={Users} color="teal" />
          )}
          {isVisible('appointment_patients') && (
            <MiniKPI label="Appointment" value={formatNumber(kpi.apptPatients)} icon={Stethoscope} color="blue" />
          )}
          {isVisible('lab_test_patients') && (
            <MiniKPI label="Lab Test" value={formatNumber(kpi.labPatients)} icon={FlaskConical} color="purple" />
          )}
          {isVisible('other_services_patients') && (
            <MiniKPI label="Other Services" value={formatNumber(kpi.otherPatients)} icon={Activity} color="amber" />
          )}
          {isVisible('direct_lab_walkins') && (
            <MiniKPI label="Direct Lab Walk-ins" value={formatNumber(kpi.directLabWalkins)} icon={ArrowRight} color="purple" sub="No appointment" />
          )}
          {isVisible('direct_other_walkins') && (
            <MiniKPI label="Direct Other Walk-ins" value={formatNumber(kpi.directOtherWalkins)} icon={ArrowRight} color="amber" sub="No appointment" />
          )}
        </div>
        );
      })()}

      {/* All Charts — single 2-column grid, items flow naturally */}
      {anyChartVisible && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          {isVisible('department_overlap') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Department Overlap</h3>
              <p className="text-xs text-theme-faint mb-4">Patients by number of departments visited</p>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={overlapData} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_STYLE} />
                  <Bar dataKey="count" fill="#10b981" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {isVisible('patient_dept_donut') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Patient Department Split</h3>
              <p className="text-xs text-theme-faint mb-4">By number of departments touched</p>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={donutData} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" strokeWidth={0}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {donutData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i]} />)}
                  </Pie>
                  <Tooltip contentStyle={CHART_STYLE} />
                </PieChart>
              </ResponsiveContainer>
              <p className="text-center text-lg font-bold text-theme-heading -mt-2">{formatNumber(kpi.totalUnique)} patients</p>
            </div>
          )}
          {isVisible('dept_combination_bars') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Department Combinations</h3>
              <p className="text-xs text-theme-faint mb-4">Patient count by department combination</p>
              <ResponsiveContainer width="100%" height={Math.max(200, comboData.length * 40)}>
                <BarChart data={comboData} layout="vertical" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={180} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_STYLE} />
                  <Bar dataKey="count" fill="#3b82f6" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {isVisible('revenue_per_patient') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Revenue Per Patient</h3>
              <p className="text-xs text-theme-faint mb-4">Average revenue: single vs multi-department</p>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={revCompareData} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => formatINR(v)} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={CHART_STYLE} />
                  <Bar dataKey="avgRevenue" name="Avg Revenue" fill="#8b5cf6" radius={[6, 6, 0, 0]}
                    label={({ x, y, width, value }: any) => {
                      const mult = baseAvg > 0 ? (value / baseAvg).toFixed(1) : '1.0';
                      return mult !== '1.0' ? (
                        <text x={x + width / 2} y={y - 8} textAnchor="middle" fill="#f59e0b" fontSize={11} fontWeight="bold">{mult}x</text>
                      ) : <></>;
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {isVisible('cross_sell_funnel') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Cross-Sell Funnel</h3>
              <p className="text-xs text-theme-faint mb-4">From appointment patients to other services</p>
              <div className="space-y-2">
                {funnelData.map((item, i) => {
                  const maxVal = funnelData[0].value || 1;
                  const width = Math.max(8, (item.value / maxVal) * 100);
                  const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#64748b'];
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary">{item.name}</span>
                        <span className="text-theme-heading font-medium">{formatNumber(item.value)} ({item.pct.toFixed(1)}%)</span>
                      </div>
                      <div className="h-7 rounded-lg overflow-hidden bg-dark-600">
                        <div className="h-full rounded-lg transition-all" style={{ width: `${width}%`, backgroundColor: colors[i] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {isVisible('patient_flow_sankey') && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Patient Flow from Appointments</h3>
              <p className="text-xs text-theme-faint mb-4">Where appointment patients go next</p>
              <div className="flex items-center gap-4 mt-6">
                <div className="flex-1 text-center">
                  <div className="text-2xl font-bold text-teal-400">{formatNumber(patientFlow.totalAppointment)}</div>
                  <div className="text-xs text-theme-faint mt-1">Appointment Patients</div>
                </div>
                <ArrowRight className="text-theme-faint shrink-0" size={20} />
                <div className="flex-1 space-y-3">
                  {[
                    { label: 'Other Services', value: patientFlow.crossToOther, color: 'text-blue-400' },
                    { label: 'Lab Tests', value: patientFlow.crossToLab, color: 'text-purple-400' },
                    { label: 'Both Lab + Other', value: patientFlow.crossToBoth, color: 'text-amber-400' },
                    { label: 'Appointment Only', value: patientFlow.apptOnly, color: 'text-theme-faint' },
                  ].map((f, i) => (
                    <div key={i} className="flex items-center justify-between bg-dark-600/50 rounded-lg px-3 py-2">
                      <span className={`text-xs font-medium ${f.color}`}>{f.label}</span>
                      <span className="text-sm font-bold text-theme-heading">{formatNumber(f.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {isVisible('doctor_cross_sell_rate') && doctorCrossSell.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Doctor Cross-Sell Rate</h3>
              <p className="text-xs text-theme-faint mb-4">Cross-sell % per doctor, sorted by rate</p>
              <div className="space-y-2 max-h-[350px] overflow-y-auto pr-2">
                {doctorCrossSell.map((d: any, i: number) => {
                  const rate = d.crossSellRate;
                  const barColor = rate >= 50 ? '#10b981' : rate >= 25 ? '#f59e0b' : '#ef4444';
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-theme-secondary truncate mr-2">{d.doctor}</span>
                        <span className="text-theme-heading font-medium shrink-0">{rate.toFixed(0)}% ({d.crossSold}/{d.totalPatients})</span>
                      </div>
                      <div className="h-5 rounded-md overflow-hidden bg-dark-600">
                        <div className="h-full rounded-md" style={{ width: `${Math.max(2, rate)}%`, backgroundColor: barColor }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {isVisible('doctor_stacked_bar') && doctorCrossSell.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold text-theme-heading mb-1">Doctor Cross-Sell Breakdown</h3>
              <p className="text-xs text-theme-faint mb-4">Cross-sold vs appointment-only per doctor</p>
              <ResponsiveContainer width="100%" height={Math.max(250, doctorStackedData.length * 35)}>
                <BarChart data={doctorStackedData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} width={120} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={CHART_STYLE} />
                  <Legend />
                  <Bar dataKey="crossSold" name="Cross-sold" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="apptOnly" name="Appt Only" stackId="a" fill="#475569" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Section E — Patient Summary Table */}
      {tableVisible && patientTable.length > 0 && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-theme-heading">Patient Summary</h3>
              <p className="text-xs text-theme-faint">{formatNumber(filteredPatients.length)} patients</p>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-theme-faint" />
              <input
                type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search patient..." className="input text-sm pl-9 w-64"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-400/20">
                  <th className="text-left text-xs font-medium text-theme-faint px-3 py-2">ID</th>
                  <th className="text-left text-xs font-medium text-theme-faint px-3 py-2">Name</th>
                  <th className="text-left text-xs font-medium text-theme-faint px-3 py-2">Departments</th>
                  <th className="text-right text-xs font-medium text-theme-faint px-3 py-2">Billed</th>
                  <th className="text-right text-xs font-medium text-theme-faint px-3 py-2">Paid</th>
                  <th className="text-right text-xs font-medium text-theme-faint px-3 py-2">Discount</th>
                  <th className="text-right text-xs font-medium text-theme-faint px-3 py-2">Visits</th>
                </tr>
              </thead>
              <tbody>
                {pagePatients.map((p: any, i: number) => (
                  <tr key={i} className="border-b border-dark-400/10 hover:bg-dark-600/30">
                    <td className="px-3 py-2 text-theme-secondary font-mono text-xs">{p.patient_id}</td>
                    <td className="px-3 py-2 text-theme-heading">{p.patient_name}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 flex-wrap">
                        {(p.departments || '').split(',').map((d: string, j: number) => (
                          <span key={j} className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-500 text-theme-faint">{d.trim()}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-theme-heading">{formatINR(p.total_billed)}</td>
                    <td className="px-3 py-2 text-right text-theme-secondary">{formatINR(p.total_paid)}</td>
                    <td className="px-3 py-2 text-right text-theme-faint">{formatINR(p.total_discount)}</td>
                    <td className="px-3 py-2 text-right text-theme-heading">{p.visits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-dark-400/20">
              <span className="text-xs text-theme-faint">Page {page + 1} of {totalPages}</span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  className="p-1.5 rounded-lg text-theme-faint hover:text-theme-secondary disabled:opacity-30"><ChevronLeft size={14} /></button>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  className="p-1.5 rounded-lg text-theme-faint hover:text-theme-secondary disabled:opacity-30"><ChevronRight size={14} /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniKPI({ label, value, icon: Icon, color, sub }: { label: string; value: string; icon: any; color: string; sub?: string }) {
  const colorMap: Record<string, string> = {
    teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  const c = colorMap[color] || colorMap.teal;
  return (
    <div className={`rounded-xl border p-3 ${c.split(' ').slice(2).join(' ')} ${c.split(' ')[0]}`}>
      <Icon size={16} className={c.split(' ')[1]} />
      <p className="text-lg font-bold text-theme-heading mt-2">{value}</p>
      <p className="text-[11px] text-theme-faint">{label}</p>
      {sub && <p className="text-[10px] text-theme-faint mt-0.5">{sub}</p>}
    </div>
  );
}
