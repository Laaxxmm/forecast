/**
 * Tally Connector — HTTP/XML communication with Tally Prime / ERP 9
 * Ported from TallyVision's tally-connector.js, adapted for Vision's async architecture.
 */

import http from 'http';
import net from 'net';
import { XMLParser } from 'fast-xml-parser';

export interface TallyConfig {
  host?: string;
  port?: number;
  timeout?: number;
}

export interface TallyCompany {
  name: string;
  fyFrom: string;
  fyTo: string;
}

export interface TallyHealthResult {
  reachable: boolean;
  version: string | null;
  companies: TallyCompany[];
  error: string | null;
  host: string;
  port: number;
}

export class TallyConnector {
  host: string;
  port: number;
  timeout: number;
  tallyVersion: string | null = null;
  private xmlParser: XMLParser;

  constructor(config: TallyConfig = {}) {
    // SSRF protection: only allow localhost/127.0.0.1 and valid port range
    const rawHost = (config.host || 'localhost').trim().toLowerCase();
    const allowedHosts = ['localhost', '127.0.0.1', '::1'];
    this.host = allowedHosts.includes(rawHost) ? rawHost : 'localhost';
    const rawPort = config.port || 9000;
    this.port = (rawPort >= 1024 && rawPort <= 65535) ? rawPort : 9000;
    this.timeout = config.timeout || 30000;
    this.xmlParser = new XMLParser({
      parseTagValue: false,
      isArray: (tagName: string) => tagName === 'ROW' || tagName.endsWith('.LIST'),
    });
  }

  /** Check if Tally is reachable via TCP */
  async ping(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(3000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(this.port, this.host);
    });
  }

  /** Send raw XML to Tally and get response */
  async sendXML(xml: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(xml, 'utf16le');
      const req = http.request({
        hostname: this.host,
        port: this.port,
        method: 'POST',
        headers: {
          'Content-Length': data.length,
          'Content-Type': 'text/xml;charset=utf-16',
        },
        timeout: this.timeout,
      }, (res) => {
        const chunks: string[] = [];
        res.setEncoding('utf16le');
        res.on('data', (chunk: string) => chunks.push(chunk));
        res.on('end', () => resolve(chunks.join('')));
        res.on('error', reject);
      });
      req.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED') reject(new Error('TALLY_NOT_RUNNING'));
        else if (err.code === 'ETIMEDOUT') reject(new Error('TALLY_TIMEOUT'));
        else reject(err);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('TALLY_TIMEOUT')); });
      req.write(data);
      req.end();
    });
  }

  /** Get list of companies from Tally */
  async getCompanies(): Promise<TallyCompany[]> {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
    <ENVELOPE>
        <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER>
        <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
        <TDL><TDLMESSAGE>
            <REPORT NAME="List of Companies"><FORMS>CompanyForm</FORMS></REPORT>
            <FORM NAME="CompanyForm"><PARTS>CompanyPart</PARTS><XMLTAG>DATA</XMLTAG></FORM>
            <PART NAME="CompanyPart"><LINES>CompanyLine</LINES><REPEAT>CompanyLine:CompanyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
            <LINE NAME="CompanyLine"><FIELDS>FldName,FldFYFrom,FldFYTo</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
            <FIELD NAME="FldName"><SET>$Name</SET><XMLTAG>F01</XMLTAG></FIELD>
            <FIELD NAME="FldFYFrom"><SET>$$YearOfDate:$BooksFrom</SET><XMLTAG>F02</XMLTAG></FIELD>
            <FIELD NAME="FldFYTo"><SET>$$YearOfDate:$BooksTo</SET><XMLTAG>F03</XMLTAG></FIELD>
            <COLLECTION NAME="CompanyCollection"><TYPE>Company</TYPE><FETCH>Name,BooksFrom,BooksTo</FETCH></COLLECTION>
        </TDLMESSAGE></TDL></DESC></BODY>
    </ENVELOPE>`;

    const response = await this.sendXML(xml);
    const parsed = this.xmlParser.parse(response);
    const rows = parsed?.DATA?.ROW || [];
    return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({
      name: r.F01,
      fyFrom: r.F02,
      fyTo: r.F03,
    }));
  }

  /** Detect Tally version (Prime vs ERP 9) */
  async detectVersion(): Promise<string> {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
    <ENVELOPE>
        <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TallyVersionReport</ID></HEADER>
        <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
        <TDL><TDLMESSAGE>
            <REPORT NAME="TallyVersionReport"><FORMS>VersionForm</FORMS></REPORT>
            <FORM NAME="VersionForm"><PARTS>VersionPart</PARTS><XMLTAG>DATA</XMLTAG></FORM>
            <PART NAME="VersionPart"><LINES>VersionLine</LINES></PART>
            <LINE NAME="VersionLine"><FIELDS>FldVersion,FldProduct</FIELDS><XMLTAG>ROW</XMLTAG></LINE>
            <FIELD NAME="FldVersion"><SET>$$LicenceInfo:SerialNumber</SET><XMLTAG>F01</XMLTAG></FIELD>
            <FIELD NAME="FldProduct"><SET>$$LicenceInfo:PlanName</SET><XMLTAG>F02</XMLTAG></FIELD>
        </TDLMESSAGE></TDL></DESC></BODY>
    </ENVELOPE>`;

    try {
      const response = await this.sendXML(xml);
      const text = response.toLowerCase();
      this.tallyVersion = (text.includes('prime') || text.includes('tallyprime')) ? 'prime' : 'erp9';
    } catch {
      this.tallyVersion = 'prime';
    }
    return this.tallyVersion;
  }

  /** Full health check */
  async healthCheck(): Promise<TallyHealthResult> {
    const result: TallyHealthResult = {
      reachable: false,
      version: null,
      companies: [],
      error: null,
      host: this.host,
      port: this.port,
    };

    try {
      result.reachable = await this.ping();
      if (!result.reachable) {
        result.error = 'Tally is not reachable. Is it running?';
        return result;
      }
      result.version = await this.detectVersion();
      result.companies = await this.getCompanies();
      if (result.companies.length === 0) {
        result.error = 'No company is currently open in Tally';
      }
    } catch (err: any) {
      result.error = err.message;
    }

    return result;
  }

  escapeXML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
