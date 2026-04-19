// ─────────────────────────────────────────────────────────────────────────────
// TallyConnector — TypeScript port of Vcfo-app/TallyVision_2.0/src/backend/
// tally-connector.js. Kept intentionally narrow: only the methods the sync
// agent needs today (ping, getCompanies, detectVersion). Extractor queries
// land in Milestone 2 in lib/tally/extractors/.
//
// Transport: HTTP POST to Tally Gateway, body is UTF-16LE-encoded TDL/XML.
// Response: XML that we parse with fast-xml-parser.
// ─────────────────────────────────────────────────────────────────────────────

import * as http from 'node:http';
import * as net from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { TallyCompany, TallyVersion } from '../types';

export interface TallyConnectorOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

export class TallyConnector {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  private readonly parser: XMLParser;

  constructor(opts: TallyConnectorOptions = {}) {
    this.host = opts.host || 'localhost';
    this.port = opts.port || 9000;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.parser = new XMLParser({
      parseTagValue: false,
      isArray: (tagName: string) => tagName === 'ROW' || tagName.endsWith('.LIST'),
    });
  }

  /** Cheap TCP probe — used for the green/red dot. 3 s timeout. */
  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(3000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(this.port, this.host);
    });
  }

  /** Send raw TDL/XML to Tally, return the XML string response. */
  sendXML(xml: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(xml, 'utf16le');
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          method: 'POST',
          headers: {
            'Content-Length': body.length,
            'Content-Type': 'text/xml;charset=utf-16',
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: string[] = [];
          res.setEncoding('utf16le');
          res.on('data', (c: string) => chunks.push(c));
          res.on('end', () => resolve(chunks.join('')));
          res.on('error', reject);
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') reject(new Error('TALLY_NOT_RUNNING'));
        else if (err.code === 'ETIMEDOUT') reject(new Error('TALLY_TIMEOUT'));
        else reject(err);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('TALLY_TIMEOUT')); });
      req.write(body);
      req.end();
    });
  }

  /** Returns the company list exposed by Tally. */
  async getCompanies(): Promise<TallyCompany[]> {
    // NOTE: we intentionally keep the TDL FIELD names in their long form
    // (FldCompanyName, FldFyFrom, FldFyTo) and DO NOT use <XMLTAG>. Tally
    // Prime's TDL parser has been observed to crash (c0000005 memory access
    // violation) on short-form FIELD names combined with XMLTAG directives.
    // The trade-off: response comes back as a flat <ENVELOPE><FLDCOMPANYNAME>
    // ...</ENVELOPE> stream rather than <DATA><ROW>…. We handle both shapes.
    const xml =
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
</ENVELOPE>`;
    const raw = await this.sendXML(xml);
    const parsed = this.parser.parse(raw) as any;
    // Nested shape: <ENVELOPE><BODY><DATA><ROW>... (older Tally versions)
    const nestedRows = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.ROW
      ?? parsed?.ENVELOPE?.BODY?.DATA?.ROW;
    if (nestedRows) {
      const arr = Array.isArray(nestedRows) ? nestedRows : [nestedRows];
      const mapped = arr
        .map((r: any) => ({
          name: String(r?.FldCompanyName ?? r?.['FLDCOMPANYNAME'] ?? '').trim(),
          fyFrom: r?.FldFyFrom ? String(r.FldFyFrom) : undefined,
          fyTo: r?.FldFyTo ? String(r.FldFyTo) : undefined,
        }))
        .filter((c: TallyCompany) => c.name.length > 0);
      if (mapped.length > 0) return mapped;
    }
    // Flat shape: <ENVELOPE><FLDCOMPANYNAME>...<FLDFYFROM>...<FLDFYTO>...
    // (Tally Prime returns this when FORM/LINE carry no XMLTAG).
    const envelope = parsed?.ENVELOPE;
    if (envelope?.FLDCOMPANYNAME) {
      const names = Array.isArray(envelope.FLDCOMPANYNAME) ? envelope.FLDCOMPANYNAME : [envelope.FLDCOMPANYNAME];
      const fromArr = Array.isArray(envelope.FLDFYFROM) ? envelope.FLDFYFROM : [envelope.FLDFYFROM];
      const toArr = Array.isArray(envelope.FLDFYTO) ? envelope.FLDFYTO : [envelope.FLDFYTO];
      return names
        .map((n: any, i: number) => ({
          name: String(n ?? '').trim(),
          fyFrom: fromArr[i] ? String(fromArr[i]) : undefined,
          fyTo: toArr[i] ? String(toArr[i]) : undefined,
        }))
        .filter((c: TallyCompany) => c.name.length > 0);
    }
    return [];
  }

  /**
   * Lightweight fingerprint: Tally Prime and ERP 9 both return the same
   * company-list schema, but Prime's response often includes <SERVERDATE>
   * while ERP 9 exposes a different envelope. For MVP we just probe both
   * flavours of the company-info query and pick the one that answers first.
   */
  async detectVersion(): Promise<TallyVersion> {
    // Prime-style company info query
    const probe =
      `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>CurrentCompany</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY>
</ENVELOPE>`;
    try {
      const raw = await this.sendXML(probe);
      if (/PRIME/i.test(raw)) return 'prime';
      if (/ERP\s*9|RELEASE\s*6/i.test(raw)) return 'erp9';
      // Default assumption: if Tally answered, it's ERP 9 (older installed base).
      return 'erp9';
    } catch {
      return 'unknown';
    }
  }
}
