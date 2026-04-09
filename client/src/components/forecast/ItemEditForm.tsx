import { useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowLeft, Edit3, MessageSquare, Plus, Trash2, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import api from '../../api/client';
import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

interface Props {
  item: ForecastItem;
  category: string;
  months: string[];
  values: Record<string, number>;
  allItems?: ForecastItem[];
  allValues?: Record<number, Record<string, number>>;
  onSave: () => Promise<void>;
  onDiscard: () => void;
}

/* ─────────── Step definitions per type ─────────── */

interface StepDef {
  key: string;
  label: string;
  question: string;
  helpText: string;
  entryModes: { value: string; label: string }[];
  defaultEntryMode: string;
  unit?: string; // e.g. "units", "Rs", "hours"
}

interface TypeDef {
  steps: StepDef[];
  formula?: string;
  computeRevenue: (stepValues: Record<string, Record<string, number>>, months: string[]) => Record<string, number>;
}

const TYPE_DEFS: Record<string, TypeDef> = {
  unit_sales: {
    steps: [
      {
        key: 'units',
        label: 'Unit Count',
        question: 'How many units do you expect?',
        helpText: "Enter the number of units you expect each month. This could be products sold, services delivered, appointments, or any countable activity that generates revenue. You can vary the count over time to reflect seasonal patterns or expected growth.",
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'constant', label: 'Constant amount' },
        ],
        defaultEntryMode: 'varying',
      },
      {
        key: 'prices',
        label: 'Revenue per Unit',
        question: 'What is the average revenue per unit?',
        helpText: 'Enter the average revenue you earn per unit (excluding GST). You can vary the amount over time to reflect planned price changes or shifts in service mix.',
        entryModes: [
          { value: 'constant', label: 'Constant amount (Rs)' },
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    formula: 'Revenue = Unit Count × Revenue per Unit',
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => {
        result[m] = Math.round((sv.units?.[m] || 0) * (sv.prices?.[m] || 0));
      });
      return result;
    },
  },

  billable_hours: {
    steps: [
      {
        key: 'hours',
        label: 'Billable Hours',
        question: 'How many billable hours per month?',
        helpText: 'Enter the number of billable hours you expect to work each month. Consider holidays, leave, and non-billable time when estimating.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'constant', label: 'Constant amount' },
        ],
        defaultEntryMode: 'constant',
      },
      {
        key: 'rates',
        label: 'Hourly Rates',
        question: 'What rate will you charge per hour?',
        helpText: 'Enter your billing rate per hour. You can set a constant rate or vary it over time to reflect planned increases.',
        entryModes: [
          { value: 'constant', label: 'Constant rate (Rs)' },
          { value: 'varying', label: 'Varying rates over time (Rs)' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    formula: 'Revenue = Hours × Rate per Hour',
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => {
        result[m] = Math.round((sv.hours?.[m] || 0) * (sv.rates?.[m] || 0));
      });
      return result;
    },
  },

  recurring: {
    steps: [
      {
        key: 'subscribers',
        label: 'Subscribers',
        question: 'How many subscribers or customers will you have?',
        helpText: 'Enter the number of paying subscribers or recurring customers you expect each month. You can model growth by varying the count over time.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'constant', label: 'Constant amount' },
        ],
        defaultEntryMode: 'varying',
      },
      {
        key: 'charge',
        label: 'Charge per Customer',
        question: 'How much will you charge each customer?',
        helpText: 'Enter the recurring charge per customer per period. This could be a monthly subscription fee, membership charge, or rental amount.',
        entryModes: [
          { value: 'constant', label: 'Constant charge (Rs)' },
          { value: 'varying', label: 'Varying charges over time (Rs)' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    formula: 'Revenue = Subscribers × Charge per Customer',
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => {
        result[m] = Math.round((sv.subscribers?.[m] || 0) * (sv.charge?.[m] || 0));
      });
      return result;
    },
  },

  revenue_only: {
    steps: [
      {
        key: 'revenue',
        label: 'Revenue',
        question: 'What revenue do you expect?',
        helpText: 'Enter your expected revenue amounts. Use this when you want to directly enter revenue totals without breaking them down into units and prices.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'constant', label: 'Constant amount' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.revenue?.[m] || 0; });
      return result;
    },
  },

  // Direct Costs
  general_cost: {
    steps: [
      {
        key: 'cost',
        label: 'Cost Amount',
        question: 'How much will it cost?',
        helpText: 'Enter the direct cost amount. This is for costs that relate to all of your revenue streams, such as materials, supplies, or other costs of goods sold.',
        entryModes: [
          { value: 'constant', label: 'Constant amount (Rs)' },
          { value: 'varying', label: 'Varying amounts over time' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.cost?.[m] || 0; });
      return result;
    },
  },

  specific_cost: {
    steps: [
      {
        key: 'cost',
        label: 'Cost Amount',
        question: 'How much will it cost each month?',
        helpText: 'Enter the cost associated with this specific revenue stream. You can enter a fixed amount, vary it over time, or set it as a percentage of the linked revenue stream.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'percent', label: 'Constant % of this stream' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.cost?.[m] || 0; });
      return result;
    },
  },

  // Personnel
  individual: {
    steps: [
      {
        key: 'salary',
        label: 'Salary',
        question: 'What will you pay this person?',
        helpText: 'Enter the gross salary for this employee, before deductions. Include base pay only — benefits and taxes can be added separately via Employee Taxes & Benefits.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'pct_overall', label: '% of overall revenue' },
          { value: 'pct_specific', label: '% of specific revenue stream' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.salary?.[m] || 0; });
      return result;
    },
  },

  group: {
    steps: [
      {
        key: 'headcount',
        label: 'Employee Count',
        question: 'How many employees are in this group?',
        helpText: 'Enter the number of employees with this role. You can model hiring plans by varying the count over time.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
        ],
        defaultEntryMode: 'varying',
      },
      {
        key: 'salary_per',
        label: 'Salary',
        question: 'What will you pay each person?',
        helpText: 'Enter the average salary for each person in this group.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'pct_overall', label: '% of overall revenue' },
          { value: 'pct_specific', label: '% of specific revenue stream' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    formula: 'Total = Headcount x Salary per Person',
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => {
        result[m] = Math.round((sv.headcount?.[m] || 0) * (sv.salary_per?.[m] || 0));
      });
      return result;
    },
  },

  // Expenses
  rent: {
    steps: [
      {
        key: 'rent',
        label: 'Rent Amount',
        question: 'How much is your rent or lease payment?',
        helpText: 'Enter the cost of your facility lease, office rent, or other lease payments. If your lease includes annual increases, you can vary the amounts over time.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'one_time', label: 'One-time amount' },
          { value: 'pct_overall', label: '% of overall revenue' },
          { value: 'pct_specific', label: '% of specific revenue stream' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.rent?.[m] || 0; });
      return result;
    },
  },

  marketing: {
    steps: [
      {
        key: 'budget',
        label: 'Marketing Budget',
        question: 'How much will you spend on marketing?',
        helpText: 'Enter your advertising, promotions, and marketing spend. Consider seasonal campaigns, festivals, or product launch periods that may require higher spending.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'one_time', label: 'One-time amount' },
          { value: 'pct_overall', label: '% of overall revenue' },
          { value: 'pct_specific', label: '% of specific revenue stream' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.budget?.[m] || 0; });
      return result;
    },
  },

  employee_benefits: {
    steps: [
      {
        key: 'rate',
        label: 'Burden Rate',
        question: 'What are your employee benefit costs?',
        helpText: 'This percentage is applied to all on-staff employee salaries. Typical range is 15-30%. It covers employer-side costs like PF, ESI, insurance, gratuity, etc.',
        entryModes: [
          { value: 'constant', label: 'Constant rate' },
          { value: 'varying', label: 'Varying rates over time' },
        ],
        defaultEntryMode: 'constant',
        unit: '%',
      },
    ],
    computeRevenue: (sv, months) => {
      // Returns 0 — actual values are calculated externally in PersonnelTab
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = 0; });
      return result;
    },
  },

  other: {
    steps: [
      {
        key: 'amount',
        label: 'Expense Amount',
        question: 'How much will this expense cost?',
        helpText: 'Enter the expected amount for this general operating expense. This includes utilities, insurance, office supplies, professional services, and other overhead costs.',
        entryModes: [
          { value: 'constant', label: 'Constant amount' },
          { value: 'varying', label: 'Varying amounts over time' },
          { value: 'one_time', label: 'One-time amount' },
          { value: 'pct_overall', label: '% of overall revenue' },
          { value: 'pct_specific', label: '% of specific revenue stream' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.amount?.[m] || 0; });
      return result;
    },
  },

  // Assets
  long_term: {
    steps: [
      {
        key: 'cost',
        label: 'Purchase Cost',
        question: 'What is the purchase cost of this asset?',
        helpText: 'Enter the cost for each month you plan to purchase this asset. For a one-time purchase, enter the amount in the purchase month only.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.cost?.[m] || 0; });
      return result;
    },
  },

  current: {
    steps: [
      {
        key: 'amount',
        label: 'Asset Amount',
        question: 'What is the monthly amount for this current asset?',
        helpText: 'Enter the monthly cost or value of current assets like inventory, prepaid expenses, or short-term investments.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.amount?.[m] || 0; });
      return result;
    },
  },

  // Taxes
  income_tax: {
    steps: [
      {
        key: 'tax',
        label: 'Tax Amount',
        question: 'What are your estimated tax payments?',
        helpText: 'Enter your estimated income tax payments by month. In India, advance tax is typically paid in quarterly installments (June, September, December, March).',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.tax?.[m] || 0; });
      return result;
    },
  },

  sales_tax: {
    steps: [
      {
        key: 'tax',
        label: 'GST Amount',
        question: 'What are your GST / sales tax amounts?',
        helpText: 'Enter your estimated GST liability per month. This is typically a percentage of your revenue.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.tax?.[m] || 0; });
      return result;
    },
  },

  // Dividends
  dividend: {
    steps: [
      {
        key: 'dividend',
        label: 'Dividend Amount',
        question: 'How much will you distribute as dividends?',
        helpText: 'Enter the dividend amounts by month. Dividends are typically distributed quarterly or annually.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.dividend?.[m] || 0; });
      return result;
    },
  },

  // Financing
  loan: {
    steps: [
      {
        key: 'repayment',
        label: 'Loan Repayment',
        question: 'What are your monthly loan repayments (EMI)?',
        helpText: 'Enter your monthly EMI or loan repayment amounts. Include both principal and interest. You can vary amounts if your repayment schedule changes.',
        entryModes: [
          { value: 'constant', label: 'Constant EMI (Rs)' },
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
        ],
        defaultEntryMode: 'constant',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.repayment?.[m] || 0; });
      return result;
    },
  },

  investment: {
    steps: [
      {
        key: 'investment',
        label: 'Investment Amount',
        question: 'What investment amounts do you expect to receive?',
        helpText: 'Enter the investment or equity funding amounts by month. Typically this is a one-time amount in the month the investment closes.',
        entryModes: [
          { value: 'varying', label: 'Varying amounts over time (Rs)' },
          { value: 'constant', label: 'Constant amount (Rs)' },
        ],
        defaultEntryMode: 'varying',
        unit: 'Rs',
      },
    ],
    computeRevenue: (sv, months) => {
      const result: Record<string, number> = {};
      months.forEach(m => { result[m] = sv.investment?.[m] || 0; });
      return result;
    },
  },
};

/* ─────────── Component ─────────── */

export default function ItemEditForm({ item, category, months, values: initialValues, allItems, allValues, onSave, onDiscard }: Props) {
  const [name, setName] = useState(item.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [saving, setSaving] = useState(false);

  // Type can be changed for direct costs (general_cost ↔ specific_cost)
  const [itemType, setItemType] = useState(item.item_type || 'revenue_only');
  const typeDef = TYPE_DEFS[itemType] || TYPE_DEFS.revenue_only;
  const steps = typeDef.steps;

  // Linked revenue stream (for specific_cost)
  const [linkedRevenueId, setLinkedRevenueId] = useState<number | null>(item.meta?.linkedRevenueId || null);
  // Percent of stream (for specific_cost percent mode)
  const [percentOfStream, setPercentOfStream] = useState<number>(item.meta?.percentOfStream || 0);
  const [percentStartMonth, setPercentStartMonth] = useState<string>(item.meta?.percentStartMonth || months[0]);

  // Personnel config (stored in meta)
  const [laborType, setLaborType] = useState<string>(item.meta?.labor_type || 'regular_labor');
  const [staffingType, setStaffingType] = useState<string>(item.meta?.staffing_type || 'on_staff');
  const [annualRaisePct, setAnnualRaisePct] = useState<number>(item.meta?.annual_raise_pct || 0);

  // Percent of revenue (for pct_overall / pct_specific entry modes in personnel)
  const [pctOfRevenue, setPctOfRevenue] = useState<number>(item.meta?.percent_of_revenue || 0);
  const [pctRevenueStartMonth, setPctRevenueStartMonth] = useState<string>(item.meta?.pct_revenue_start_month || months[0]);
  const [pctLinkedRevenueId, setPctLinkedRevenueId] = useState<number | null>(item.meta?.linked_revenue_id || null);

  // One-time entry mode state
  const [oneTimeMonth, setOneTimeMonth] = useState<string>(item.meta?.oneTimeMonth || months[0]);
  const [oneTimeAmount, setOneTimeAmount] = useState<number>(item.meta?.oneTimeAmount || 0);

  // Revenue items for the revenue stream selector
  const revenueItems = useMemo(() => (allItems || []).filter(i => i.category === 'revenue'), [allItems]);

  // Current active step
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const activeStep = steps[activeStepIdx];

  // Entry modes per step
  const [stepEntryModes, setStepEntryModes] = useState<Record<string, string>>(() => {
    const modes: Record<string, string> = {};
    steps.forEach(s => {
      modes[s.key] = item.meta?.stepEntryModes?.[s.key] || s.defaultEntryMode;
    });
    return modes;
  });

  // Constant values per step (for constant mode)
  const [stepConstants, setStepConstants] = useState<Record<string, { amount: number; period: string; startMonth: string }>>(() => {
    const constants: Record<string, { amount: number; period: string; startMonth: string }> = {};
    steps.forEach(s => {
      constants[s.key] = item.meta?.stepConstants?.[s.key] || {
        amount: 0,
        period: 'month',
        startMonth: months[0],
      };
    });
    return constants;
  });

  // Per-step monthly values (for varying mode or computed from constant)
  const [stepValues, setStepValues] = useState<Record<string, Record<string, number>>>(() => {
    if (item.meta?.stepValues) {
      return item.meta.stepValues;
    }
    if (steps.length === 1) {
      return { [steps[0].key]: { ...initialValues } };
    }
    const sv: Record<string, Record<string, number>> = {};
    steps.forEach(s => { sv[s.key] = {}; });
    return sv;
  });

  // Compute constant values into step values
  useEffect(() => {
    steps.forEach(step => {
      if (stepEntryModes[step.key] === 'constant') {
        const c = stepConstants[step.key];
        if (c && c.amount > 0) {
          const newVals: Record<string, number> = {};
          const amount = c.period === 'year' ? c.amount / 12 : c.amount;
          months.forEach(m => {
            if (m >= c.startMonth) {
              newVals[m] = Math.round(amount * 100) / 100;
            }
          });
          setStepValues(prev => ({ ...prev, [step.key]: newVals }));
        }
      }
    });
  }, [stepEntryModes, stepConstants, months]);

  // Compute percent-of-stream values
  useEffect(() => {
    if (itemType === 'specific_cost' && stepEntryModes.cost === 'percent' && linkedRevenueId && percentOfStream > 0) {
      const revenueVals = allValues?.[linkedRevenueId] || {};
      const newVals: Record<string, number> = {};
      months.forEach(m => {
        if (m >= percentStartMonth) {
          newVals[m] = Math.round((revenueVals[m] || 0) * percentOfStream / 100);
        }
      });
      setStepValues(prev => ({ ...prev, cost: newVals }));
    }
  }, [itemType, stepEntryModes, linkedRevenueId, percentOfStream, percentStartMonth, allValues, months]);

  // Compute pct_overall values (% of total revenue)
  useEffect(() => {
    steps.forEach(step => {
      if (stepEntryModes[step.key] === 'pct_overall' && pctOfRevenue > 0) {
        const newVals: Record<string, number> = {};
        months.forEach(m => {
          if (m >= pctRevenueStartMonth) {
            // Sum all revenue items' values for this month
            const totalRevenue = revenueItems.reduce((sum, ri) => sum + (allValues?.[ri.id]?.[m] || 0), 0);
            newVals[m] = Math.round(totalRevenue * pctOfRevenue / 100);
          }
        });
        setStepValues(prev => ({ ...prev, [step.key]: newVals }));
      }
    });
  }, [stepEntryModes, pctOfRevenue, pctRevenueStartMonth, allValues, months, revenueItems]);

  // Compute pct_specific values (% of a specific revenue stream)
  useEffect(() => {
    steps.forEach(step => {
      if (stepEntryModes[step.key] === 'pct_specific' && pctLinkedRevenueId && pctOfRevenue > 0) {
        const revenueVals = allValues?.[pctLinkedRevenueId] || {};
        const newVals: Record<string, number> = {};
        months.forEach(m => {
          if (m >= pctRevenueStartMonth) {
            newVals[m] = Math.round((revenueVals[m] || 0) * pctOfRevenue / 100);
          }
        });
        setStepValues(prev => ({ ...prev, [step.key]: newVals }));
      }
    });
  }, [stepEntryModes, pctLinkedRevenueId, pctOfRevenue, pctRevenueStartMonth, allValues, months]);

  // Compute one_time values
  useEffect(() => {
    steps.forEach(step => {
      if (stepEntryModes[step.key] === 'one_time' && oneTimeAmount > 0) {
        const newVals: Record<string, number> = {};
        months.forEach(m => {
          newVals[m] = m === oneTimeMonth ? oneTimeAmount : 0;
        });
        setStepValues(prev => ({ ...prev, [step.key]: newVals }));
      }
    });
  }, [stepEntryModes, oneTimeMonth, oneTimeAmount, months]);

  // Compute final monthly values from all steps
  const computedValues = useMemo(() => {
    return typeDef.computeRevenue(stepValues, months);
  }, [stepValues, months, typeDef]);

  const total = useMemo(() => months.reduce((s, m) => s + (computedValues[m] || 0), 0), [computedValues, months]);

  const chartData = useMemo(() => months.map(m => ({
    month: getMonthLabel(m),
    forecast: computedValues[m] || 0,
  })), [computedValues, months]);

  const stepStatus = useCallback((stepKey: string) => {
    const vals = stepValues[stepKey] || {};
    const hasAnyValue = Object.values(vals).some(v => v > 0);
    return hasAnyValue ? 'complete' : 'incomplete';
  }, [stepValues]);

  const updateStepMonthValue = (month: string, value: string) => {
    const num = parseFloat(value) || 0;
    setStepValues(prev => ({
      ...prev,
      [activeStep.key]: { ...prev[activeStep.key], [month]: num },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/forecast-module/items/${item.id}`, {
        name,
        item_type: itemType,
        entry_mode: steps.length === 1 ? stepEntryModes[steps[0].key] : 'varying',
        meta: {
          stepValues,
          stepEntryModes,
          stepConstants,
          linkedRevenueId,
          percentOfStream,
          percentStartMonth,
          // Personnel fields
          labor_type: laborType,
          staffing_type: staffingType,
          annual_raise_pct: annualRaisePct,
          percent_of_revenue: pctOfRevenue,
          pct_revenue_start_month: pctRevenueStartMonth,
          linked_revenue_id: pctLinkedRevenueId,
          oneTimeMonth,
          oneTimeAmount,
        },
      });

      const valuesArray = months.map(m => ({ month: m, amount: computedValues[m] || 0 }));
      await api.post('/forecast-module/values', { item_id: item.id, values: valuesArray });

      await onSave();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await api.delete(`/forecast-module/items/${item.id}`);
    await onSave();
  };

  // Is this a direct cost type with type switching?
  const isDirectCost = category === 'direct_costs';
  const directCostTypes = [
    { value: 'general_cost', label: 'General Cost' },
    { value: 'specific_cost', label: 'Specific Cost' },
  ];

  // Is this an expense type with type switching?
  const isExpense = category === 'expenses';
  const expenseTypes = [
    { value: 'rent', label: 'Rent or lease' },
    { value: 'marketing', label: 'Marketing' },
    { value: 'employee_benefits', label: 'Employee taxes or benefits' },
    { value: 'other', label: 'Other expense' },
  ];

  const currentStepValues = stepValues[activeStep.key] || {};
  const currentStepTotal = months.reduce((s, m) => s + (currentStepValues[m] || 0), 0);

  return (
    <div className="max-w-[1200px]">
      {/* ──── Header ──── */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <button onClick={onDiscard} className="p-2 hover:bg-dark-500 rounded-lg transition-colors">
            <ArrowLeft size={20} className="text-theme-muted" />
          </button>
          {isEditingName ? (
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={() => setIsEditingName(false)}
              onKeyDown={e => e.key === 'Enter' && setIsEditingName(false)}
              autoFocus
              className="text-2xl font-bold text-theme-heading bg-dark-700 border-2 border-primary-400 rounded-lg outline-none px-3 py-1"
            />
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold text-theme-heading">{name}</h2>
              <button onClick={() => setIsEditingName(true)} className="p-1 hover:bg-dark-500 rounded text-theme-muted hover:text-theme-muted">
                <Edit3 size={14} />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-dark-400 rounded-lg overflow-hidden text-sm mr-3">
            <button className="px-4 py-1.5 bg-dark-700 text-theme-faint hover:bg-dark-600">Yearly</button>
            <button className="px-4 py-1.5 bg-slate-800 text-theme-heading font-medium">Monthly</button>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-500 rounded-lg text-sm mr-3">
            <span className="w-5 h-5 rounded bg-teal-600 text-white text-[10px] font-bold flex items-center justify-center">F</span>
            <span className="text-theme-muted font-medium">Forecast</span>
          </div>
          <button className="p-2 hover:bg-dark-500 rounded-lg text-theme-muted" title="Comment"><MessageSquare size={16} /></button>
          <button className="p-2 hover:bg-dark-500 rounded-lg text-theme-muted" title="Add"><Plus size={16} /></button>
          <button onClick={handleDelete} className="p-2 hover:bg-red-500/10 text-theme-muted hover:text-red-400 rounded-lg" title="Delete"><Trash2 size={16} /></button>
        </div>
      </div>

      {/* ──── Type selector ──── */}
      <div className="flex items-center gap-3 mb-5">
        <span className="text-sm text-theme-faint flex items-center gap-1">
          Type
          <Info size={12} className="text-theme-muted" />
        </span>
        {isDirectCost ? (
          <>
            <select
              value={itemType}
              onChange={e => {
                setItemType(e.target.value);
                // Reset percent state when switching
                if (e.target.value === 'general_cost') {
                  setLinkedRevenueId(null);
                  if (stepEntryModes.cost === 'percent') {
                    setStepEntryModes(prev => ({ ...prev, cost: 'constant' }));
                  }
                }
              }}
              className="input text-sm w-auto py-1.5"
            >
              {directCostTypes.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            {itemType === 'specific_cost' && (
              <select
                value={linkedRevenueId || ''}
                onChange={e => setLinkedRevenueId(parseInt(e.target.value) || null)}
                className="input text-sm w-auto py-1.5"
              >
                <option value="">Select a revenue stream...</option>
                {revenueItems.map(ri => (
                  <option key={ri.id} value={ri.id}>{ri.name}</option>
                ))}
              </select>
            )}
          </>
        ) : isExpense ? (
          <select
            value={itemType}
            onChange={e => setItemType(e.target.value)}
            className="input text-sm w-auto py-1.5"
          >
            {expenseTypes.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1.5 border border-dark-400/50 rounded-lg text-sm bg-dark-700">
            <span className="text-base">
              {itemType === 'unit_sales' ? '🏥' : itemType === 'billable_hours' ? '⏱' : itemType === 'recurring' ? '🔄' : itemType === 'revenue_only' ? '💰' :
               itemType === 'individual' ? '👤' : itemType === 'group' ? '👥' :
               itemType === 'rent' ? '🏢' : itemType === 'marketing' ? '📣' : itemType === 'loan' ? '🏦' : '📋'}
            </span>
            <span className="font-medium text-theme-secondary">
              {steps.length > 1 ? typeDef.formula?.split('=')[0]?.trim() || itemType.replace(/_/g, ' ') : activeStep.label}
            </span>
          </div>
        )}
      </div>

      {/* ──── Personnel Config Dropdowns ──── */}
      {category === 'personnel' && itemType !== 'employee_benefits' && (
        <div className="bg-dark-700 rounded-xl border border-dark-400/50 p-4 mb-5">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-medium text-theme-faint mb-1 block">Personnel Type</label>
              <select
                value={itemType}
                onChange={e => setItemType(e.target.value)}
                className="input text-sm"
              >
                <option value="individual">Individual</option>
                <option value="group">Group of employees</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-theme-faint mb-1 block">Labor Type</label>
              <select
                value={laborType}
                onChange={e => setLaborType(e.target.value)}
                className="input text-sm"
              >
                <option value="regular_labor">Regular Labor</option>
                <option value="direct_labor">Direct Labor</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-theme-faint mb-1 block">Staffing Type</label>
              <select
                value={staffingType}
                onChange={e => setStaffingType(e.target.value)}
                className="input text-sm"
              >
                <option value="on_staff">On-staff employee</option>
                <option value="contract">Contract worker</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* ──── Chart ──── */}
      <div className="bg-dark-700 rounded-xl border border-dark-400/50 overflow-hidden mb-5">
        <div className="p-5">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                <YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" tickFormatter={v => {
                  if (v >= 100000) return `Rs${(v / 100000).toFixed(1)}L`;
                  if (v >= 1000) return `Rs${(v / 1000).toFixed(0)}k`;
                  return `Rs${v}`;
                }} />
                <Tooltip
                  formatter={(value: number) => [formatRs(value)]}
                  labelFormatter={(label) => label}
                  contentStyle={{ borderRadius: 8, fontSize: 12, backgroundColor: '#14141f', borderColor: '#2a2a3d', color: '#e2e8f0' }}
                />
                <Line type="monotone" dataKey="forecast" name="Forecast" stroke="#0d9488" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 3, fill: '#0d9488', stroke: '#0d9488' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Monthly values scroll row */}
        <div className="flex overflow-x-auto border-t border-dark-400/30">
          {months.map(m => (
            <div key={m} className="text-center min-w-[85px] flex-shrink-0 py-2.5 border-r border-dark-400/30 last:border-0">
              <div className="text-[10px] text-theme-muted mb-0.5">{getMonthLabel(m)}</div>
              <div className="text-xs font-semibold text-theme-secondary tabular-nums">{formatRs(computedValues[m] || 0)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ──── Step Tabs (only show if multiple steps) ──── */}
      {steps.length > 1 && (
        <div className="bg-dark-700 rounded-t-xl border border-b-0 border-dark-400/50 flex">
          {steps.map((step, idx) => {
            const isActive = idx === activeStepIdx;
            const status = stepStatus(step.key);
            return (
              <button
                key={step.key}
                onClick={() => setActiveStepIdx(idx)}
                className={`flex-1 py-4 px-6 flex items-center justify-center gap-2.5 transition-all border-b-[3px] ${
                  isActive
                    ? 'border-teal-500 bg-teal-50/30'
                    : 'border-transparent hover:bg-dark-600'
                }`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                  isActive ? 'border-teal-500 text-teal-600' : 'border-dark-400 text-theme-muted'
                }`}>
                  {idx + 1}
                </span>
                <span className={`font-semibold text-sm ${isActive ? 'text-theme-heading' : 'text-theme-faint'}`}>
                  {step.label}
                </span>
                {status === 'incomplete' && !isActive && (
                  <AlertTriangle size={14} className="text-amber-500" />
                )}
                {status === 'complete' && !isActive && (
                  <CheckCircle size={14} className="text-teal-500" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ──── Step Content ──── */}
      <div className={`bg-dark-700 border border-dark-400/50 p-6 ${steps.length > 1 ? 'rounded-b-xl' : 'rounded-xl'} mb-5`}>
        {/* Entry mode selector */}
        <div className="flex items-center gap-3 mb-6">
          <span className="text-sm font-medium text-theme-muted">{isDirectCost ? 'How do you want to enter this cost?' : 'How will you enter this?'}</span>
          <select
            value={stepEntryModes[activeStep.key]}
            onChange={e => setStepEntryModes(prev => ({ ...prev, [activeStep.key]: e.target.value }))}
            className="input text-sm w-auto"
          >
            {activeStep.entryModes.map(em => (
              <option key={em.value} value={em.value}>{em.label}</option>
            ))}
          </select>
        </div>

        <div className="border-t border-dark-400/30 pt-6">
          {/* ── Constant mode — simple price layout (single Rs input) ── */}
          {stepEntryModes[activeStep.key] === 'constant' && activeStep.unit === 'Rs' && !isDirectCost && !isExpense && category !== 'personnel' && (
            <div className="flex items-start gap-8">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2 mb-2">
                  {activeStep.question}
                  <Info size={16} className="text-teal-500 cursor-help" />
                </h3>
                <p className="text-sm text-theme-faint leading-relaxed max-w-xl">{activeStep.helpText}</p>
              </div>
              <div className="flex-shrink-0 pt-1">
                <input
                  type="number"
                  value={stepConstants[activeStep.key]?.amount || ''}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 0;
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], amount: val },
                    }));
                  }}
                  placeholder="Rs"
                  className="input text-sm w-44"
                />
              </div>
            </div>
          )}

          {/* ── Constant mode — Personnel salary layout (Rs + per + starting + annual raise) ── */}
          {stepEntryModes[activeStep.key] === 'constant' && activeStep.unit === 'Rs' && category === 'personnel' && (
            <div>
              <div className="flex items-start gap-6 mb-4">
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2 mb-2">
                    {activeStep.question}
                    <Info size={16} className="text-teal-500 cursor-help" />
                  </h3>
                  <p className="text-sm text-theme-faint leading-relaxed max-w-xl">{activeStep.helpText}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-theme-muted">Rs</span>
                    <input
                      type="number"
                      value={stepConstants[activeStep.key]?.amount || ''}
                      onChange={e => {
                        const val = parseFloat(e.target.value) || 0;
                        setStepConstants(prev => ({
                          ...prev,
                          [activeStep.key]: { ...prev[activeStep.key], amount: val },
                        }));
                      }}
                      placeholder="0"
                      className="input text-sm w-36 pl-8"
                    />
                  </div>
                  <span className="text-sm text-theme-faint font-medium">per</span>
                  <select
                    value={stepConstants[activeStep.key]?.period || 'month'}
                    onChange={e => {
                      setStepConstants(prev => ({
                        ...prev,
                        [activeStep.key]: { ...prev[activeStep.key], period: e.target.value },
                      }));
                    }}
                    className="input text-sm w-28"
                  >
                    <option value="month">Month</option>
                    <option value="year">Year</option>
                  </select>
                  <span className="text-sm text-theme-faint font-medium">starting</span>
                  <select
                    value={stepConstants[activeStep.key]?.startMonth || months[0]}
                    onChange={e => {
                      setStepConstants(prev => ({
                        ...prev,
                        [activeStep.key]: { ...prev[activeStep.key], startMonth: e.target.value },
                      }));
                    }}
                    className="input text-sm w-36"
                  >
                    {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                  </select>
                </div>
              </div>
              {/* Annual raise */}
              <div className="flex items-center gap-3 pt-3 border-t border-dark-400/30">
                <label className="text-sm text-theme-muted font-medium">Annual raise</label>
                <input
                  type="number"
                  value={annualRaisePct || ''}
                  onChange={e => setAnnualRaisePct(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="input text-sm w-20"
                  step="0.5"
                />
                <span className="text-sm text-theme-faint">%</span>
              </div>
            </div>
          )}

          {/* ── Constant mode — % unit (burden rate) ── */}
          {stepEntryModes[activeStep.key] === 'constant' && activeStep.unit === '%' && (
            <div className="flex items-start gap-8">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2 mb-2">
                  {activeStep.question}
                  <Info size={16} className="text-teal-500 cursor-help" />
                </h3>
                <p className="text-sm text-theme-faint leading-relaxed max-w-xl">{activeStep.helpText}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 pt-1">
                <input
                  type="number"
                  value={stepConstants[activeStep.key]?.amount || ''}
                  onChange={e => {
                    const val = parseFloat(e.target.value) || 0;
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], amount: val },
                    }));
                  }}
                  placeholder="0"
                  className="input text-sm w-28"
                  step="0.5"
                />
                <span className="text-sm text-theme-faint font-medium">%</span>
              </div>
            </div>
          )}

          {/* ── Constant mode — Direct Cost / Expense layout (Rs + per + starting, side by side) ── */}
          {stepEntryModes[activeStep.key] === 'constant' && (isDirectCost || isExpense) && (
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2 mb-2">
                  {activeStep.question}
                </h3>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-theme-muted">Rs</span>
                  <input
                    type="number"
                    value={stepConstants[activeStep.key]?.amount || ''}
                    onChange={e => {
                      const val = parseFloat(e.target.value) || 0;
                      setStepConstants(prev => ({
                        ...prev,
                        [activeStep.key]: { ...prev[activeStep.key], amount: val },
                      }));
                    }}
                    placeholder="0"
                    className="input text-sm w-36 pl-8"
                  />
                </div>
                <span className="text-sm text-theme-faint font-medium">per</span>
                <select
                  value={stepConstants[activeStep.key]?.period || 'month'}
                  onChange={e => {
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], period: e.target.value },
                    }));
                  }}
                  className="input text-sm w-28"
                >
                  <option value="month">Month</option>
                  <option value="year">Year</option>
                </select>
                <span className="text-sm text-theme-faint font-medium">starting</span>
                <select
                  value={stepConstants[activeStep.key]?.startMonth || months[0]}
                  onChange={e => {
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], startMonth: e.target.value },
                    }));
                  }}
                  className="input text-sm w-36"
                >
                  {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* ── Constant mode — full stacked layout (counts, headcount, etc.) ── */}
          {stepEntryModes[activeStep.key] === 'constant' && activeStep.unit !== 'Rs' && !isDirectCost && (
            <>
              <div className="mb-2">
                <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2">
                  {activeStep.question}
                  <Info size={16} className="text-teal-500 cursor-help" />
                </h3>
              </div>
              <p className="text-sm text-theme-faint leading-relaxed mb-6 max-w-3xl">{activeStep.helpText}</p>

              <div className="flex items-center gap-3 flex-wrap">
                <div className="max-w-[220px]">
                  <input
                    type="number"
                    value={stepConstants[activeStep.key]?.amount || ''}
                    onChange={e => {
                      const val = parseFloat(e.target.value) || 0;
                      setStepConstants(prev => ({
                        ...prev,
                        [activeStep.key]: { ...prev[activeStep.key], amount: val },
                      }));
                    }}
                    placeholder="0"
                    className="input text-sm w-full"
                  />
                </div>
                <span className="text-sm text-theme-faint font-medium">per</span>
                <select
                  value={stepConstants[activeStep.key]?.period || 'month'}
                  onChange={e => {
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], period: e.target.value },
                    }));
                  }}
                  className="input text-sm w-28"
                >
                  <option value="month">Month</option>
                  <option value="year">Year</option>
                </select>
                <span className="text-sm text-theme-faint font-medium">starting</span>
                <select
                  value={stepConstants[activeStep.key]?.startMonth || months[0]}
                  onChange={e => {
                    setStepConstants(prev => ({
                      ...prev,
                      [activeStep.key]: { ...prev[activeStep.key], startMonth: e.target.value },
                    }));
                  }}
                  className="input text-sm w-36"
                >
                  {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                </select>
              </div>
            </>
          )}

          {/* ── Percent of stream mode (specific_cost only) ── */}
          {stepEntryModes[activeStep.key] === 'percent' && (
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading mb-2">
                  What percentage of this revenue stream?
                </h3>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="number"
                  value={percentOfStream || ''}
                  onChange={e => setPercentOfStream(parseFloat(e.target.value) || 0)}
                  placeholder=""
                  className="input text-sm w-28"
                  step="0.5"
                />
                <span className="text-sm text-theme-faint font-medium">%</span>
                <span className="text-sm text-theme-faint font-medium">starting</span>
                <select
                  value={percentStartMonth}
                  onChange={e => setPercentStartMonth(e.target.value)}
                  className="input text-sm w-36"
                >
                  {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* ── % of overall revenue mode ── */}
          {stepEntryModes[activeStep.key] === 'pct_overall' && (
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading mb-2">
                  What percentage of overall revenue?
                </h3>
                <p className="text-sm text-theme-faint leading-relaxed">This salary will be calculated as a percentage of your total revenue across all streams.</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="number"
                  value={pctOfRevenue || ''}
                  onChange={e => setPctOfRevenue(parseFloat(e.target.value) || 0)}
                  placeholder=""
                  className="input text-sm w-28"
                  step="0.5"
                />
                <span className="text-sm text-theme-faint font-medium">%</span>
                <span className="text-sm text-theme-faint font-medium">starting</span>
                <select
                  value={pctRevenueStartMonth}
                  onChange={e => setPctRevenueStartMonth(e.target.value)}
                  className="input text-sm w-36"
                >
                  {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* ── % of specific revenue stream mode ── */}
          {stepEntryModes[activeStep.key] === 'pct_specific' && (
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading mb-2">
                  What percentage of a specific revenue stream?
                </h3>
                <p className="text-sm text-theme-faint leading-relaxed">Select a revenue stream and enter the percentage.</p>
              </div>
              <div className="flex flex-col gap-2 flex-shrink-0">
                <select
                  value={pctLinkedRevenueId || ''}
                  onChange={e => setPctLinkedRevenueId(parseInt(e.target.value) || null)}
                  className="input text-sm"
                >
                  <option value="">Select a revenue stream...</option>
                  {revenueItems.map(ri => (
                    <option key={ri.id} value={ri.id}>{ri.name}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={pctOfRevenue || ''}
                    onChange={e => setPctOfRevenue(parseFloat(e.target.value) || 0)}
                    placeholder=""
                    className="input text-sm w-28"
                    step="0.5"
                  />
                  <span className="text-sm text-theme-faint font-medium">%</span>
                  <span className="text-sm text-theme-faint font-medium">starting</span>
                  <select
                    value={pctRevenueStartMonth}
                    onChange={e => setPctRevenueStartMonth(e.target.value)}
                    className="input text-sm w-36"
                  >
                    {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ── One-time amount mode ── */}
          {stepEntryModes[activeStep.key] === 'one_time' && (
            <div className="flex items-start gap-6">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-theme-heading mb-2">
                  When will this expense occur?
                </h3>
                <p className="text-sm text-theme-faint">Select the month and enter the one-time amount.</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-theme-muted">Rs</span>
                  <input
                    type="number"
                    value={oneTimeAmount || ''}
                    onChange={e => setOneTimeAmount(parseFloat(e.target.value) || 0)}
                    placeholder="0"
                    className="input text-sm w-36 pl-8"
                  />
                </div>
                <span className="text-sm text-theme-faint font-medium">in</span>
                <select
                  value={oneTimeMonth}
                  onChange={e => setOneTimeMonth(e.target.value)}
                  className="input text-sm w-36"
                >
                  {months.map(m => <option key={m} value={m}>{getMonthLabel(m)}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* ── Varying mode heading ── */}
          {stepEntryModes[activeStep.key] === 'varying' && (
            <>
              <div className="mb-2">
                <h3 className="text-lg font-bold text-theme-heading flex items-center gap-2">
                  {activeStep.question}
                  <Info size={16} className="text-teal-500 cursor-help" />
                </h3>
              </div>
              <p className="text-sm text-theme-faint leading-relaxed mb-6 max-w-3xl">{activeStep.helpText}</p>
            </>
          )}

          {/* Varying mode — monthly grid table */}
          {stepEntryModes[activeStep.key] === 'varying' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border border-dark-400/50 rounded-lg overflow-hidden" style={{ minWidth: '900px' }}>
                <thead>
                  <tr className="bg-dark-600">
                    <th className="text-left py-2.5 px-3 font-semibold text-theme-muted w-20 border-r border-dark-400/50"></th>
                    {months.map(m => {
                      const [, mo] = m.split('-');
                      const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                      return (
                        <th key={m} className="text-center py-2.5 px-1.5 font-semibold text-theme-muted border-r border-dark-400/50 last:border-0 min-w-[70px]">
                          {monthNames[parseInt(mo)]}
                        </th>
                      );
                    })}
                    <th className="text-center py-2.5 px-3 font-bold text-theme-secondary min-w-[80px] bg-dark-500">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-dark-400/50">
                    <td className="py-2 px-3 text-sm font-medium text-theme-muted border-r border-dark-400/50 bg-dark-700">
                      <div className="flex items-center gap-1">
                        <div className="w-1 h-6 bg-primary-400 rounded-full"></div>
                        <span className="text-xs text-theme-faint">
                          {months[0].slice(0, 4)}-{months[months.length - 1].slice(2, 4)}
                        </span>
                      </div>
                    </td>
                    {months.map(m => (
                      <td key={m} className="py-1 px-1 border-r border-dark-400/50 last:border-0">
                        <input
                          type="number"
                          value={currentStepValues[m] || ''}
                          onChange={e => updateStepMonthValue(m, e.target.value)}
                          placeholder=""
                          className="w-full text-center py-1.5 px-1 text-sm border-0 focus:bg-accent-500/10 focus:ring-2 focus:ring-primary-300 rounded outline-none tabular-nums"
                        />
                      </td>
                    ))}
                    <td className="py-2 px-3 text-center font-bold text-theme-secondary bg-dark-600 tabular-nums">
                      {currentStepTotal > 0 ? currentStepTotal.toLocaleString('en-IN') : '0'}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* Reset Form */}
              <button
                onClick={() => {
                  const cleared: Record<string, number> = {};
                  months.forEach(m => { cleared[m] = 0; });
                  setStepValues(prev => ({ ...prev, [activeStep.key]: cleared }));
                }}
                className="flex items-center gap-1.5 text-sm text-theme-faint hover:text-theme-secondary mt-3 px-2 py-1 border border-dark-400 rounded-lg hover:bg-dark-600"
              >
                <span className="text-xs">✕</span> Reset Form
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ──── Action buttons ──── */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary px-8 py-2.5"
          >
            {saving ? 'Saving...' : 'Save & Exit'}
          </button>
          <button onClick={onDiscard} className="text-sm text-teal-600 hover:text-teal-700 font-medium px-4 py-2.5">
            Discard changes
          </button>
        </div>

        {/* Step navigation */}
        {steps.length > 1 && (
          <div>
            {activeStepIdx > 0 && (
              <button
                onClick={() => setActiveStepIdx(prev => prev - 1)}
                className="px-5 py-2.5 border-2 border-teal-600 text-teal-600 rounded-lg font-medium text-sm hover:bg-teal-50 mr-2"
              >
                ← {steps[activeStepIdx - 1].label}
              </button>
            )}
            {activeStepIdx < steps.length - 1 && (
              <button
                onClick={() => setActiveStepIdx(prev => prev + 1)}
                className="px-5 py-2.5 border-2 border-teal-600 text-teal-600 rounded-lg font-medium text-sm hover:bg-teal-50"
              >
                {steps[activeStepIdx + 1].label} →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
