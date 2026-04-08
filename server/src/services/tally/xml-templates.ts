/**
 * Tally XML Report Templates — TDL-based report definitions
 * Ported from TallyVision's xml-templates.js for Vision VCFO module.
 */

const companyBlock = (c?: string) => c ? `<SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>` : '';

function xmlWrap(reportId: string, formId: string, partId: string, staticVars: string, tdlBody: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${reportId}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${staticVars}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="${reportId}"><FORMS>${formId}</FORMS></REPORT>
<FORM NAME="${formId}"><PARTS>${partId}</PARTS><XMLTAG>DATA</XMLTAG></FORM>
${tdlBody}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export const TEMPLATES = {
  'list-masters': (collection: string, company?: string) => xmlWrap('TVList', 'TVListF', 'TVListP',
    companyBlock(company),
    `<PART NAME="TVListP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>${collection}</TYPE></COLLECTION>`
  ),

  'chart-of-accounts': (company?: string) => xmlWrap('TVCoA', 'TVCoAF', 'TVCoAP',
    companyBlock(company),
    `<PART NAME="TVCoAP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $IsRevenue then "PL" else "BS"</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>if $IsDeemedPositive then "D" else "C"</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>if $AffectsGrossProfit then "Y" else "N"</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Group</TYPE></COLLECTION>`
  ),

  'trial-balance': (fromDate: string, toDate: string, company?: string) => xmlWrap('TVTB', 'TVTBF', 'TVTBP',
    `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
    `<PART NAME="TVTBP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05,F06</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$OpeningBalance then -$$NumValue:$OpeningBalance else $$NumValue:$OpeningBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>$$NumValue:$DebitTotals</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$CreditTotals</SET><XMLTAG>F05</XMLTAG></FIELD>
<FIELD NAME="F06"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F06</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
  ),

  'profit-loss': (fromDate: string, toDate: string, company?: string) => xmlWrap('TVPL', 'TVPLF', 'TVPLP',
    `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
    `<PART NAME="TVPLP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
  ),

  'balance-sheet': (fromDate: string, toDate: string, company?: string) => xmlWrap('TVBS', 'TVBSF', 'TVBSP',
    `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
    `<PART NAME="TVBSP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$ClosingBalance then -$$NumValue:$ClosingBalance else $$NumValue:$ClosingBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>Ledger</TYPE></COLLECTION>`
  ),

  'daybook': (fromDate: string, toDate: string, company?: string) => {
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>TVDaybook</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="TVDaybook"><TYPE>Voucher</TYPE>
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Amount,Narration</NATIVEMETHOD>
</COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  },

  'stock-summary': (fromDate: string, toDate: string, company?: string) => xmlWrap('TVSS', 'TVSSF', 'TVSSP',
    `<SVFROMDATE>${fromDate}</SVFROMDATE><SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}`,
    `<PART NAME="TVSSP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="L1"><FIELDS>F01,F02,F03,F04,F05,F06,F07,F08,F09,F10</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Parent</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>$$NumValue:$OpeningBalance</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>$$NumValue:$OpeningValue</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>$$NumValue:$InwardQuantity</SET><XMLTAG>F05</XMLTAG></FIELD>
<FIELD NAME="F06"><SET>$$NumValue:$InwardValue</SET><XMLTAG>F06</XMLTAG></FIELD>
<FIELD NAME="F07"><SET>$$NumValue:$OutwardQuantity</SET><XMLTAG>F07</XMLTAG></FIELD>
<FIELD NAME="F08"><SET>$$NumValue:$OutwardValue</SET><XMLTAG>F08</XMLTAG></FIELD>
<FIELD NAME="F09"><SET>$$NumValue:$ClosingBalance</SET><XMLTAG>F09</XMLTAG></FIELD>
<FIELD NAME="F10"><SET>$$NumValue:$ClosingValue</SET><XMLTAG>F10</XMLTAG></FIELD>
<COLLECTION NAME="C1"><TYPE>StockItem</TYPE></COLLECTION>`
  ),

  'bills-outstanding': (toDate: string, nature: string, company?: string) => {
    const groupName = nature.toLowerCase().startsWith('r') ? 'Sundry Debtors' : 'Sundry Creditors';
    const SC = '<' + '/SYSTEM>';
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVBills</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
<SVTODATE>${toDate}</SVTODATE>${companyBlock(company)}</STATICVARIABLES>
<TDL><TDLMESSAGE>
<REPORT NAME="TVBills"><FORMS>TVBillsF</FORMS></REPORT>
<FORM NAME="TVBillsF"><PARTS>TVBillsP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
<PART NAME="TVBillsP"><LINES>TVBillsL</LINES><REPEAT>TVBillsL:CBills</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="TVBillsL"><FIELDS>F01,F02,F03,F04,F05</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
<FIELD NAME="F01"><SET>$BillDate</SET><XMLTAG>F01</XMLTAG></FIELD>
<FIELD NAME="F02"><SET>$Name</SET><XMLTAG>F02</XMLTAG></FIELD>
<FIELD NAME="F03"><SET>if $$IsDebit:$Amount then -$$NumValue:$Amount else $$NumValue:$Amount</SET><XMLTAG>F03</XMLTAG></FIELD>
<FIELD NAME="F04"><SET>##CurLedName</SET><XMLTAG>F04</XMLTAG></FIELD>
<FIELD NAME="F05"><SET>if $$IsBlank:$BillDate then 0 else $$NumValue:$$Age:$BillDate:$$AsOnDate</SET><XMLTAG>F05</XMLTAG></FIELD>
<COLLECTION NAME="CBills"><TYPE>Ledger</TYPE><CHILDOF>${groupName}</CHILDOF>
<VARIABLE>CurLedName</VARIABLE><WALK>BillAllocations</WALK>
<FILTERS>TVBillOutstanding</FILTERS></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="TVBillOutstanding">$$NumValue:$Amount != 0${SC}
<VARIABLE NAME="CurLedName" USE="Name Field"/>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  },
} as const;
