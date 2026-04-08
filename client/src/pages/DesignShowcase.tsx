import { BarChart3, TrendingUp, TrendingDown, AlertCircle, CheckCircle, Info, AlertTriangle, DollarSign, Users, Package, Activity } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const mockData = [
  { label: 'Jan', clinic: 450000, pharmacy: 320000 },
  { label: 'Feb', clinic: 520000, pharmacy: 380000 },
  { label: 'Mar', clinic: 480000, pharmacy: 410000 },
  { label: 'Apr', clinic: 590000, pharmacy: 460000 },
  { label: 'May', clinic: 620000, pharmacy: 520000 },
  { label: 'Jun', clinic: 710000, pharmacy: 580000 },
];

const revenueData = [
  { name: 'Consultation', value: 35 },
  { name: 'Procedures', value: 28 },
  { name: 'Lab Tests', value: 22 },
  { name: 'Imaging', value: 15 },
];

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b'];

export default function DesignShowcase() {
  return (
    <div className="min-h-screen bg-dark-900 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-theme-heading mb-2">Forecast Design System</h1>
          <p className="text-lg text-theme-muted">Modern Corporate UI Showcase</p>
        </div>

        {/* KPI Cards Section */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">KPI Cards & Metrics</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="card border border-emerald-500/25 hover:border-emerald-500/40 transition-all">
              <div className="flex items-start justify-between mb-4">
                <div className="p-3 rounded-lg bg-emerald-500/12">
                  <DollarSign size={20} className="text-emerald-400" />
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md text-emerald-400 bg-emerald-500/15 border border-emerald-500/20">
                  <TrendingUp size={12} />
                  +12.5%
                </div>
              </div>
              <p className="text-xs text-theme-faint font-semibold uppercase tracking-widest">Total Revenue</p>
              <p className="text-3xl font-bold text-theme-heading mt-2">₹45.2L</p>
              <p className="text-xs text-theme-muted mt-3">This month</p>
            </div>

            <div className="card border border-blue-500/25 hover:border-blue-500/40 transition-all">
              <div className="flex items-start justify-between mb-4">
                <div className="p-3 rounded-lg bg-blue-500/12">
                  <Users size={20} className="text-blue-400" />
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md text-emerald-400 bg-emerald-500/15 border border-emerald-500/20">
                  <TrendingUp size={12} />
                  +8.3%
                </div>
              </div>
              <p className="text-xs text-theme-faint font-semibold uppercase tracking-widest">Total Patients</p>
              <p className="text-3xl font-bold text-theme-heading mt-2">2,847</p>
              <p className="text-xs text-theme-muted mt-3">Active patients</p>
            </div>

            <div className="card border border-purple-500/25 hover:border-purple-500/40 transition-all">
              <div className="flex items-start justify-between mb-4">
                <div className="p-3 rounded-lg bg-purple-500/12">
                  <Package size={20} className="text-purple-400" />
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md text-red-400 bg-red-500/15 border border-red-500/20">
                  <TrendingDown size={12} />
                  -3.2%
                </div>
              </div>
              <p className="text-xs text-theme-faint font-semibold uppercase tracking-widest">Pharmacy Sales</p>
              <p className="text-3xl font-bold text-theme-heading mt-2">₹18.9L</p>
              <p className="text-xs text-theme-muted mt-3">Medications & supplies</p>
            </div>

            <div className="card border border-amber-500/25 hover:border-amber-500/40 transition-all">
              <div className="flex items-start justify-between mb-4">
                <div className="p-3 rounded-lg bg-amber-500/12">
                  <Activity size={20} className="text-amber-400" />
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md text-emerald-400 bg-emerald-500/15 border border-emerald-500/20">
                  <TrendingUp size={12} />
                  +5.7%
                </div>
              </div>
              <p className="text-xs text-theme-faint font-semibold uppercase tracking-widest">Avg Margin</p>
              <p className="text-3xl font-bold text-theme-heading mt-2">34.2%</p>
              <p className="text-xs text-theme-muted mt-3">Profit margin</p>
            </div>
          </div>
        </section>

        {/* Charts Section */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">Data Visualization</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="card lg:col-span-2">
              <h3 className="text-base font-bold text-theme-heading mb-1">Monthly Revenue Trend</h3>
              <p className="text-sm text-theme-muted mb-6">Clinic vs Pharmacy revenue breakdown</p>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={mockData} barGap={3} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 100000).toFixed(1)}L`} tick={{ fontSize: 12, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={50} />
                  <Tooltip
                    formatter={(v: number) => `₹${(v / 100000).toFixed(1)}L`}
                    contentStyle={{ backgroundColor: '#14141f', border: '1px solid #2a2a3d', borderRadius: '10px', padding: '12px' }}
                    labelStyle={{ color: '#f1f5f9', fontWeight: 600 }}
                    cursor={{ fill: 'rgba(16, 185, 129, 0.05)' }}
                  />
                  <Legend wrapperStyle={{ paddingTop: '16px' }} />
                  <Bar dataKey="clinic" name="Clinic" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="pharmacy" name="Pharmacy" fill="#8b5cf6" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <h3 className="text-base font-bold text-theme-heading mb-1">Revenue Split</h3>
              <p className="text-sm text-theme-muted mb-6">By department</p>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={revenueData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {revenueData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => `${value}%`} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-2 mt-4">
                {revenueData.map((item, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                      <span className="text-theme-muted">{item.name}</span>
                    </div>
                    <span className="font-semibold text-theme-heading">{item.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Buttons & States */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">Buttons & Interactive Elements</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="font-semibold text-theme-heading mb-4">Button States</h3>
              <div className="space-y-3">
                <button className="btn-primary w-full">Primary Button</button>
                <button className="btn-primary w-full opacity-50 cursor-not-allowed">Disabled Button</button>
                <button className="btn-secondary w-full">Secondary Button</button>
                <button className="btn-danger w-full">Delete Button</button>
              </div>
            </div>

            <div className="card">
              <h3 className="font-semibold text-theme-heading mb-4">Badge Variants</h3>
              <div className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  <span className="badge badge-success">✓ Success</span>
                  <span className="badge badge-warning">⚠ Warning</span>
                  <span className="badge badge-danger">✕ Danger</span>
                  <span className="badge badge-info">ℹ Info</span>
                  <span className="badge badge-neutral">Neutral</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Forms & Inputs */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">Forms & Inputs</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card">
              <div className="input-group mb-4">
                <label className="input-label">Full Name</label>
                <input type="text" className="input" placeholder="Enter your name" />
                <p className="input-hint">Your full legal name</p>
              </div>

              <div className="input-group mb-4">
                <label className="input-label">Email Address</label>
                <input type="email" className="input" placeholder="you@example.com" />
              </div>

              <div className="input-group mb-4">
                <label className="input-label">Select Department</label>
                <select className="input">
                  <option>Choose a department...</option>
                  <option>Clinic</option>
                  <option>Pharmacy</option>
                  <option>Lab</option>
                </select>
              </div>

              <div className="input-group mb-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" />
                  <span className="text-sm text-theme-primary">I agree to the terms</span>
                </label>
              </div>
            </div>

            <div className="card">
              <div className="input-group mb-4">
                <label className="input-label">Message</label>
                <textarea className="input" placeholder="Type your message here..."></textarea>
              </div>

              <div className="input-group mb-4">
                <label className="input-label">Revenue</label>
                <input type="number" className="input" placeholder="0.00" />
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input type="radio" name="option" id="opt1" />
                  <label htmlFor="opt1" className="text-sm text-theme-primary cursor-pointer">Option 1</label>
                </div>
                <div className="flex items-center gap-2">
                  <input type="radio" name="option" id="opt2" />
                  <label htmlFor="opt2" className="text-sm text-theme-primary cursor-pointer">Option 2</label>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Alerts */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">Alerts & Messages</h2>
          <div className="space-y-4">
            <div className="alert alert-success">
              <CheckCircle size={18} className="flex-shrink-0" />
              <div>
                <p className="font-semibold">Success!</p>
                <p className="text-sm opacity-90">Your changes have been saved successfully.</p>
              </div>
            </div>

            <div className="alert alert-info">
              <Info size={18} className="flex-shrink-0" />
              <div>
                <p className="font-semibold">Information</p>
                <p className="text-sm opacity-90">This is an informational message for users.</p>
              </div>
            </div>

            <div className="alert alert-warning">
              <AlertTriangle size={18} className="flex-shrink-0" />
              <div>
                <p className="font-semibold">Warning</p>
                <p className="text-sm opacity-90">Please review this important warning message.</p>
              </div>
            </div>

            <div className="alert alert-danger">
              <AlertCircle size={18} className="flex-shrink-0" />
              <div>
                <p className="font-semibold">Error</p>
                <p className="text-sm opacity-90">An error occurred while processing your request.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Table Sample */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-theme-heading mb-6">Data Tables</h2>
          <div className="card overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Revenue</th>
                  <th>Patients</th>
                  <th>Margin</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Consultation</td>
                  <td className="font-semibold text-theme-heading">₹12.5L</td>
                  <td>428</td>
                  <td>42%</td>
                  <td><span className="badge badge-success">Active</span></td>
                </tr>
                <tr>
                  <td>Procedures</td>
                  <td className="font-semibold text-theme-heading">₹18.2L</td>
                  <td>156</td>
                  <td>38%</td>
                  <td><span className="badge badge-success">Active</span></td>
                </tr>
                <tr>
                  <td>Lab Tests</td>
                  <td className="font-semibold text-theme-heading">₹8.9L</td>
                  <td>892</td>
                  <td>35%</td>
                  <td><span className="badge badge-warning">Pending</span></td>
                </tr>
                <tr>
                  <td>Imaging</td>
                  <td className="font-semibold text-theme-heading">₹5.6L</td>
                  <td>234</td>
                  <td>28%</td>
                  <td><span className="badge badge-success">Active</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
