import { ArrowLeft } from 'lucide-react';

interface TypeOption {
  value: string;
  label: string;
  description: string;
  icon?: string;
}

interface Props {
  title: string;
  question: string;
  types: TypeOption[];
  onSelect: (type: string) => void;
  onBack: () => void;
}

const TYPE_ICONS: Record<string, string> = {
  // Revenue
  unit_sales: '🏥',
  billable_hours: '⏱',
  recurring: '🔄',
  revenue_only: '💰',
  // Direct Costs
  general_cost: '🏭',
  specific_cost: '🔗',
  direct_cost: '🏭',
  direct_labor: '👷',
  // Personnel
  individual: '👤',
  group: '👥',
  // Expenses
  rent: '🏢',
  marketing: '📣',
  employee_benefits: '👥',
  other: '📋',
  // Assets
  long_term: '🏗',
  current: '📦',
  // Taxes
  income_tax: '🧾',
  sales_tax: '💹',
  // Dividends
  dividend: '💵',
  // Financing
  loan: '🏦',
  investment: '📈',
};

export default function TypeSelectionScreen({ title, question, types, onSelect, onBack }: Props) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
          <ArrowLeft size={20} className="text-slate-600" />
        </button>
        <h2 className="text-2xl font-bold text-slate-800">{title}</h2>
      </div>

      {/* Card layout */}
      <div className="max-w-3xl">
        <div className="bg-white rounded-xl border border-slate-200 p-8">
          <h3 className="text-lg font-semibold text-slate-700 mb-6">{question}</h3>

          <div className="grid grid-cols-2 gap-4">
            {types.map(t => (
              <button
                key={t.value}
                onClick={() => onSelect(t.value)}
                className="text-left p-5 rounded-xl border-2 border-slate-200 hover:border-primary-400 hover:bg-primary-50/30 transition-all group"
              >
                <div className="flex items-center gap-3 mb-1.5">
                  <span className="text-xl">{TYPE_ICONS[t.value] || '📋'}</span>
                  <span className="font-semibold text-slate-800 group-hover:text-primary-700">{t.label}</span>
                </div>
                <p className="text-sm text-slate-500 leading-relaxed ml-9">{t.description}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { TYPE_ICONS };
