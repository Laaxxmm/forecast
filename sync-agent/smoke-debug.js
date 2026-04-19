const { TallyConnector } = require('./dist-electron/lib/tally/connector');
const conn = new TallyConnector({ host: 'localhost', port: 9000, timeoutMs: 10000 });

const queries = {
    'ORIGINAL flat (no XMLTAG)':
        `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE>
    <REPORT NAME="List of Companies"><FORMS>CompanyForm</FORMS></REPORT>
    <FORM NAME="CompanyForm"><PARTS>CompanyPart</PARTS></FORM>
    <PART NAME="CompanyPart"><LINES>CompanyLine</LINES><REPEAT>CompanyLine : CompanyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
    <LINE NAME="CompanyLine"><FIELDS>FldCompanyName,FldFyFrom,FldFyTo</FIELDS></LINE>
    <FIELD NAME="FldCompanyName"><SET>$Name</SET></FIELD>
    <FIELD NAME="FldFyFrom"><SET>$StartingFrom</SET></FIELD>
    <FIELD NAME="FldFyTo"><SET>$EndingAt</SET></FIELD>
    <COLLECTION NAME="CompanyCollection"><TYPE>Company</TYPE></COLLECTION>
  </TDLMESSAGE></TDL></DESC></BODY>
</ENVELOPE>`,
    'NEW with XMLTAG (might hang)':
        `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TVCompanies</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  <TDL><TDLMESSAGE>
    <REPORT NAME="TVCompanies"><FORMS>TVCompaniesF</FORMS></REPORT>
    <FORM NAME="TVCompaniesF"><PARTS>TVCompaniesP</PARTS><XMLTAG>DATA</XMLTAG></FORM>
    <PART NAME="TVCompaniesP"><LINES>L1</LINES><REPEAT>L1:C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
    <LINE NAME="L1"><FIELDS>F01,F02,F03</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
    <FIELD NAME="F01"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
    <FIELD NAME="F02"><SET>$StartingFrom</SET><XMLTAG>F02</XMLTAG></FIELD>
    <FIELD NAME="F03"><SET>$EndingAt</SET><XMLTAG>F03</XMLTAG></FIELD>
    <COLLECTION NAME="C1"><TYPE>Company</TYPE></COLLECTION>
  </TDLMESSAGE></TDL></DESC></BODY>
</ENVELOPE>`,
};

(async () => {
    for (const [name, xml] of Object.entries(queries)) {
        console.log('\n====== ' + name + ' ======');
        const t0 = Date.now();
        try {
            const raw = await conn.sendXML(xml);
            console.log('[' + (Date.now() - t0) + 'ms] ' + raw.length + ' bytes');
            console.log(raw.slice(0, 600));
        } catch (err) {
            console.log('[' + (Date.now() - t0) + 'ms] ERR: ' + err.message);
        }
    }
})();
