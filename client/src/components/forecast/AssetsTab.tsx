import { useState } from 'react';
import { Plus, GripVertical, FileDown, ChevronDown, ChevronRight, StickyNote } from 'lucide-react';
import api from '../../api/client';
import { Scenario, ForecastItem, FY, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';
import ItemEditForm from './ItemEditForm';
import AssetCreateModal, { AssetConfig } from './AssetCreateModal';
import ItemRowMenu from './ItemRowMenu';
import { buildForecastWorkbook } from '../../utils/forecastWorkbook';

interface Props {
  category: string;
  label: string;
  scenario: Scenario | null;
  fy: FY | null;
  months: string[];
  viewMode: 'monthly' | 'yearly';
  items: ForecastItem[];
  allItems: ForecastItem[];
  allValues: Record<number, Record<string, number>>;
  settings: Record<string, any>;
  onReload: () => Promise<void>;
  readOnly?: boolean;
}

export default function AssetsTab({ category, label, scenario, fy, months, viewMode, items, allItems, allValues, settings, onReload, readOnly }: Props) {
  const [editingItem, setEditingItem] = useState<ForecastItem | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const currentAssets = items.filter(i => i.item_type === 'current');
  const longTermAssets = items.filter(i => i.item_type === 'long_term' || !i.item_type);
  const investmentAssets = items.filter(i => i.item_type === 'investment');

  // Calculate section totals
  const calcSectionTotals = (sectionItems: ForecastItem[]) => {
    const totals: Record<string, number> = {};
    months.forEach(m => {
      totals[m] = sectionItems.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
    });
    return totals;
  };

  const currentTotals = calcSectionTotals(currentAssets);
  const longTermTotals = calcSectionTotals(longTermAssets);
  const investmentTotals = calcSectionTotals(investmentAssets);
  const grandTotals: Record<string, number> = {};
  months.forEach(m => {
    grandTotals[m] = (currentTotals[m] || 0) + (longTermTotals[m] || 0) + (investmentTotals[m] || 0);
  });

  const toggleSection = (section: string) => {
    setCollapsedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const collapseAll = () => {
    const allCollapsed = Object.values(collapsedSections).filter(Boolean).length >= 3;
    setCollapsedSections({ current: !allCollapsed, long_term: !allCollapsed, investment: !allCollapsed });
  };

  const handleCreate = async (config: AssetConfig) => {
    if (!scenario) return;
    try {
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category: 'assets',
        name: config.name,
        item_type: config.assetType,
        entry_mode: 'varying',
        start_month: months[0],
        meta: {
          useful_life: config.usefulLife,
          custom_life_value: config.customLifeValue,
          plan_to_sell: config.planToSell,
        },
      });
      setShowCreateModal(false);
      await onReload();
      if (res.data?.id) {
        setEditingItem(res.data);
      }
    } catch (err) {
      console.error('Failed to create asset:', err);
    }
  };

  const handleDuplicate = async (item: ForecastItem) => {
    if (!scenario) return;
    try {
      const res = await api.post('/forecast-module/items', {
        scenario_id: scenario.id,
        category: item.category,
        name: `${item.name} (Copy)`,
        item_type: item.item_type,
        entry_mode: item.entry_mode,
        constant_amount: item.constant_amount,
        constant_period: item.constant_period,
        start_month: item.start_month,
        meta: item.meta,
      });
      const vals = allValues[item.id];
      if (vals && Object.keys(vals).length > 0) {
        await api.post('/forecast-module/values', {
          item_id: res.data.id,
          values: Object.entries(vals).map(([month, amount]) => ({ month, amount })),
        });
      }
      await onReload();
    } catch (err) {
      console.error('Failed to duplicate asset:', err);
    }
  };

  if (editingItem && !readOnly) {
    return (
      <ItemEditForm
        item={editingItem}
        category={category}
        months={months}
        values={allValues[editingItem.id] || {}}
        allItems={allItems}
        allValues={allValues}
        onSave={async () => {
          setEditingItem(null);
          await onReload();
        }}
        onDiscard={() => setEditingItem(null)}
      />
    );
  }

  const renderItemRow = (item: ForecastItem) => {
    const itemValues = allValues[item.id] || {};
    const rowTotal = months.reduce((sum, m) => sum + (itemValues[m] || 0), 0);
    const meta = item.meta || {};
    const lifeLabel = meta.useful_life === 'forever' ? 'No depreciation'
      : meta.useful_life === 'full' ? 'Full value'
      : meta.useful_life === 'custom' ? `${meta.custom_life_value}yr`
      : meta.useful_life?.endsWith('m') ? `${meta.useful_life.replace('m', '')}mo`
      : meta.useful_life ? `${meta.useful_life}yr` : '';

    return (
      <tr key={item.id} className="border-b border-dark-400/30 hover:bg-dark-600 group">
        <td className="py-2.5 px-4 sticky left-0 bg-dark-700 z-10 group-hover:bg-dark-600">
          <div className="flex items-center gap-2">
            {!readOnly && <GripVertical size={14} className="text-theme-secondary cursor-grab opacity-0 group-hover:opacity-100" />}
            <div className="flex flex-col">
              {readOnly ? (
                <span className="text-theme-secondary font-medium text-left">{item.name}</span>
              ) : (
                <button
                  onClick={() => setEditingItem(item)}
                  className="text-accent-400 hover:text-accent-300 font-medium hover:underline text-left"
                >
                  {item.name}
                </button>
              )}
              {lifeLabel && (
                <span className="text-[10px] text-theme-faint">{lifeLabel}</span>
              )}
            </div>
            {item.meta?.note && (
              <span title={item.meta.note}><StickyNote size={12} className="text-amber-400 shrink-0" /></span>
            )}
            {!readOnly && (
              <div className="relative ml-auto">
                <ItemRowMenu
                  item={item}
                  items={items}
                  category={category}
                  allValues={allValues}
                  onEdit={() => setEditingItem(item)}
                  onDuplicate={() => handleDuplicate(item)}
                  onReload={onReload}
                />
              </div>
            )}
          </div>
        </td>
        {months.map(m => (
          <td key={m} className="text-right py-2.5 px-3 text-theme-secondary tabular-nums">
            {itemValues[m] ? formatRs(itemValues[m]) : <span className="text-theme-secondary">-</span>}
          </td>
        ))}
        <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums">
          {formatRs(rowTotal)}
        </td>
      </tr>
    );
  };

  const renderSectionHeader = (sectionKey: string, sectionLabel: string, sectionItems: ForecastItem[], sectionTotals: Record<string, number>) => {
    const isCollapsed = collapsedSections[sectionKey];
    const sectionTotal = months.reduce((sum, m) => sum + (sectionTotals[m] || 0), 0);

    return (
      <>
        <tr
          className="border-b border-dark-400/50 bg-dark-600/70 cursor-pointer hover:bg-dark-600"
          onClick={() => toggleSection(sectionKey)}
        >
          <td className="py-2.5 px-4 sticky left-0 bg-dark-600/70 z-10">
            <div className="flex items-center gap-2">
              {isCollapsed ? <ChevronRight size={14} className="text-theme-faint" /> : <ChevronDown size={14} className="text-theme-faint" />}
              <span className="font-semibold text-sm text-theme-muted">{sectionLabel}</span>
              <span className="text-xs text-theme-faint">({sectionItems.length})</span>
            </div>
          </td>
          {isCollapsed && months.map(m => (
            <td key={m} className="text-right py-2.5 px-3 text-theme-muted tabular-nums text-sm font-medium">
              {sectionTotals[m] ? formatRs(sectionTotals[m]) : '-'}
            </td>
          ))}
          {isCollapsed && (
            <td className="text-right py-2.5 px-4 font-semibold text-theme-heading bg-dark-500 tabular-nums">
              {formatRs(sectionTotal)}
            </td>
          )}
          {!isCollapsed && <td colSpan={months.length + 1} />}
        </tr>
        {!isCollapsed && sectionItems.map(renderItemRow)}
        {!isCollapsed && (
          <tr className="border-b border-dark-400/50 bg-dark-700/50">
            <td className="py-2 px-4 sticky left-0 bg-dark-700/50 z-10 text-sm font-medium text-theme-faint pl-10">
              {sectionLabel} subtotal
            </td>
            {months.map(m => (
              <td key={m} className="text-right py-2 px-3 text-theme-muted tabular-nums text-sm font-medium">
                {sectionTotals[m] ? formatRs(sectionTotals[m]) : '-'}
              </td>
            ))}
            <td className="text-right py-2 px-4 font-semibold text-theme-heading bg-dark-600 tabular-nums text-sm">
              {formatRs(sectionTotal)}
            </td>
          </tr>
        )}
      </>
    );
  };

  const grandTotal = months.reduce((sum, m) => sum + (grandTotals[m] || 0), 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-theme-heading">{label}</h2>
          <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 font-medium cursor-pointer">In Progress</span>
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <>
              <button
                onClick={collapseAll}
                className="text-xs text-theme-faint hover:text-theme-secondary border border-dark-400/50 rounded-lg px-2.5 py-1.5 hover:bg-dark-500 transition-colors"
              >
                {Object.values(collapsedSections).filter(Boolean).length >= 2 ? 'Expand all' : 'Collapse all'}
              </button>
              <button
                onClick={async () => {
                  try {
                    const branchName = (typeof window !== 'undefined' ? localStorage.getItem('branch_name') : '') || undefined;
                    const streamName = (typeof window !== 'undefined' ? localStorage.getItem('stream_name') : '') || undefined;
                    const blob = await buildForecastWorkbook({
                      items: allItems, allValues, months, settings, scenario, fy,
                      branchName, streamName, singleCategory: category,
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    const fyTag = fy?.label ? `_${fy.label.replace(/\s+/g, '_')}` : '';
                    const branchTag = branchName ? `_${branchName.replace(/\s+/g, '_')}` : '';
                    const labelTag = label.replace(/\s+/g, '_');
                    link.download = `Forecast_${labelTag}${fyTag}${branchTag}.xlsx`;
                    link.click();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    console.error('Forecast XLSX export failed:', e);
                    alert('Could not generate the Excel workbook. Check the browser console for details.');
                  }
                }}
                className="mt-btn-gradient"
                style={{ padding: '6px 12px', fontSize: 12 }}
                title={`Download just the ${label} sheet as Excel (linked formulas + calculation method)`}
              >
                <FileDown size={14} />
                Excel
              </button>
            </>
          )}
          {!readOnly && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <Plus size={16} />
              Add Asset
            </button>
          )}
        </div>
      </div>

      {/* Data Table */}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm" style={{ minWidth: months.length * 100 + 300 }}>
          <thead>
            <tr className="border-b border-dark-400/50 bg-dark-600">
              <th className="text-left py-3 px-4 font-semibold text-theme-muted sticky left-0 bg-dark-600 z-10 min-w-[240px]">
                <div className="flex items-center gap-2">
                  <span>Assets</span>
                  <button className="text-xs text-theme-muted hover:text-theme-secondary border border-dark-400 rounded px-2 py-0.5">Organize</button>
                </div>
              </th>
              {months.map(m => (
                <th key={m} className="text-right py-3 px-3 font-semibold text-theme-muted whitespace-nowrap min-w-[100px]">
                  {getMonthLabel(m)}
                </th>
              ))}
              <th className="text-right py-3 px-4 font-semibold text-theme-muted bg-dark-500 min-w-[120px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {/* Current Assets Section */}
            {renderSectionHeader('current', 'Current assets', currentAssets, currentTotals)}

            {/* Long-term Assets Section */}
            {renderSectionHeader('long_term', 'Long-term assets', longTermAssets, longTermTotals)}

            {/* Investments Section */}
            {renderSectionHeader('investment', 'Investments', investmentAssets, investmentTotals)}

            {/* Grand Totals */}
            <tr className="border-t-2 border-accent-500/30 bg-dark-600 font-semibold">
              <td className="py-3 px-4 text-theme-secondary sticky left-0 bg-dark-600 z-10">Totals</td>
              {months.map(m => (
                <td key={m} className="text-right py-3 px-3 text-theme-heading tabular-nums">
                  {formatRs(grandTotals[m] || 0)}
                </td>
              ))}
              <td className="text-right py-3 px-4 text-theme-heading bg-dark-500 tabular-nums">
                {formatRs(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Create Modal */}
      <AssetCreateModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
        months={months}
      />

    </div>
  );
}
