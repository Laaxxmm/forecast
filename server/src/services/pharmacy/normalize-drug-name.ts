// Strip OneGlance dose-form prefixes so that "TAB.ROSACHOL 10MG" (transfer
// rows) and "TAB ROSACHOL 10MG" (sales/stock rows) join on the same key when
// matching satellite sales to incoming transfers for COGS.
const PREFIX_RE = /^(TAB|INJ|SYR|CAP|CRM|OINT|GEL|PWD|LIQD|VIAL|DPS|SUSP|INHL|SPRY|DRP|EYE|EAR|LOTN|SHMP|ENM|SOLN|TONIC|KIT)\.?\s+/i;

export function normalizeDrugName(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw).replace(PREFIX_RE, '').trim().toUpperCase();
}
