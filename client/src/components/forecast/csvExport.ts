import { ForecastItem, getMonthLabel, formatRs } from '../../pages/ForecastModulePage';

/**
 * Export visible table data as CSV and trigger download
 */
export function exportTableCSV(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
  viewMode: 'monthly' | 'yearly',
  category: string,
  categoryLabel: string,
) {
  // Build column headers
  const headers = [categoryLabel];
  if (viewMode === 'yearly') {
    headers.push('Annual Total');
  } else {
    months.forEach(m => headers.push(getMonthLabel(m)));
    headers.push('Total');
  }

  // Build data rows
  const rows: string[][] = [];
  items.forEach(item => {
    const row = [item.name];
    if (viewMode === 'yearly') {
      const total = months.reduce((sum, m) => sum + (allValues[item.id]?.[m] || 0), 0);
      row.push(String(total));
    } else {
      months.forEach(m => {
        row.push(String(allValues[item.id]?.[m] || 0));
      });
      const total = months.reduce((sum, m) => sum + (allValues[item.id]?.[m] || 0), 0);
      row.push(String(total));
    }
    rows.push(row);
  });

  // Totals row
  const totalsRow = ['Totals'];
  if (viewMode === 'yearly') {
    const grandTotal = items.reduce((sum, item) =>
      sum + months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0), 0
    );
    totalsRow.push(String(grandTotal));
  } else {
    months.forEach(m => {
      const monthTotal = items.reduce((sum, item) => sum + (allValues[item.id]?.[m] || 0), 0);
      totalsRow.push(String(monthTotal));
    });
    const grandTotal = items.reduce((sum, item) =>
      sum + months.reduce((s, m) => s + (allValues[item.id]?.[m] || 0), 0), 0
    );
    totalsRow.push(String(grandTotal));
  }
  rows.push(totalsRow);

  // Generate CSV string
  const csvContent = [
    headers.map(h => `"${h}"`).join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
  ].join('\n');

  // Trigger download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${categoryLabel.replace(/\s+/g, '_')}_${viewMode}_export.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Export all items across all categories as CSV
 */
export function exportAllItemsCSV(
  items: ForecastItem[],
  allValues: Record<number, Record<string, number>>,
  months: string[],
  viewMode: 'monthly' | 'yearly',
) {
  const categories = ['revenue', 'direct_costs', 'personnel', 'expenses', 'assets', 'taxes', 'dividends'];
  const catLabels: Record<string, string> = {
    revenue: 'Revenue',
    direct_costs: 'Direct Costs',
    personnel: 'Personnel',
    expenses: 'Expenses',
    assets: 'Assets',
    taxes: 'Taxes',
    dividends: 'Dividends',
  };

  const headers = ['Category', 'Item'];
  if (viewMode === 'yearly') {
    headers.push('Annual Total');
  } else {
    months.forEach(m => headers.push(getMonthLabel(m)));
    headers.push('Total');
  }

  const rows: string[][] = [];
  categories.forEach(cat => {
    const catItems = items.filter(i => i.category === cat);
    if (catItems.length === 0) return;
    catItems.forEach(item => {
      const row = [catLabels[cat] || cat, item.name];
      if (viewMode === 'yearly') {
        const total = months.reduce((sum, m) => sum + (allValues[item.id]?.[m] || 0), 0);
        row.push(String(total));
      } else {
        months.forEach(m => row.push(String(allValues[item.id]?.[m] || 0)));
        const total = months.reduce((sum, m) => sum + (allValues[item.id]?.[m] || 0), 0);
        row.push(String(total));
      }
      rows.push(row);
    });
  });

  const csvContent = [
    headers.map(h => `"${h}"`).join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Forecast_${viewMode}_export.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
