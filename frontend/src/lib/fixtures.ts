// Demo fixtures. Every raw line here is produced by reconstructing tokens + vars
// (CONTRACTS section 1), so the fixtures obey the same losslessness rule as the engine.
// The ASA 302013 line is the spec's own example (sections 3.2 and 7.4).

import type {
  DemoScenario, ParseStatus, QuarantineCluster, SlotType, Token,
} from './types';

const L = (lit: string): Token => ({ lit });
const S = (slot: string, type: SlotType, values?: string[]): Token =>
  values ? { slot, type, values } : { slot, type };

export type MapRule =
  | string
  | { path: string; enum?: Record<string, number>; transform?: 'to_int' | 'to_ip' | 'lowercase' | 'ts_parse' };

export interface TemplateFixture {
  template_id: string;
  pack: string;
  pack_version: number;
  source_id: string;
  vendor: string;
  product: string;
  class_uid: number;
  activity_id: number;
  tokens: Token[];
  constants: Record<string, string | number>;
  map: Record<string, MapRule>; // slot -> OCSF path
  unmapped_keep: string[];
  /** Slot holding the syslog PRI, used for severity derivation. */
  pri_slot?: string;
  /** Slot holding the original timestamp string. */
  time_slot?: string;
  /** Fallback severity when there is no PRI. */
  severity_id?: number;
}

/* ---------------- templates ---------------- */

export const TEMPLATES: TemplateFixture[] = [
  {
    template_id: 'asa_302013',
    pack: 'cisco_asa',
    pack_version: 4,
    source_id: 'fw01',
    vendor: 'Cisco',
    product: 'ASA',
    class_uid: 4001,
    activity_id: 1,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' %ASA-6-302013: Built '), S('direction', 'enum', ['inbound', 'outbound']),
      L(' TCP connection '), S('conn_id', 'int'),
      L(' for '), S('if_a', 'hostname'), L(':'), S('ip_a', 'ip'), L('/'), S('port_a', 'port'),
      L(' ('), S('mip_a', 'ip'), L('/'), S('mport_a', 'port'),
      L(') to '), S('if_b', 'hostname'), L(':'), S('ip_b', 'ip'), L('/'), S('port_b', 'port'),
      L(' ('), S('mip_b', 'ip'), L('/'), S('mport_b', 'port'), L(')'),
    ],
    constants: { 'connection_info.protocol_name': 'tcp' },
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      direction: { path: 'connection_info.direction_id', enum: { inbound: 1, outbound: 2 } },
      conn_id: 'connection_info.uid',
      if_a: 'dst_endpoint.interface_name',
      ip_a: 'dst_endpoint.ip',
      port_a: { path: 'dst_endpoint.port', transform: 'to_int' },
      if_b: 'src_endpoint.interface_name',
      ip_b: 'src_endpoint.ip',
      port_b: { path: 'src_endpoint.port', transform: 'to_int' },
    },
    unmapped_keep: ['mip_a', 'mport_a', 'mip_b', 'mport_b'],
  },
  {
    template_id: 'asa_302014',
    pack: 'cisco_asa',
    pack_version: 4,
    source_id: 'fw01',
    vendor: 'Cisco',
    product: 'ASA',
    class_uid: 4001,
    activity_id: 2,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' %ASA-6-302014: Teardown TCP connection '), S('conn_id', 'int'),
      L(' for '), S('if_a', 'hostname'), L(':'), S('ip_a', 'ip'), L('/'), S('port_a', 'port'),
      L(' to '), S('if_b', 'hostname'), L(':'), S('ip_b', 'ip'), L('/'), S('port_b', 'port'),
      L(' duration '), S('duration', 'word'), L(' bytes '), S('bytes', 'int'), L(' TCP FINs'),
    ],
    constants: { 'connection_info.protocol_name': 'tcp' },
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      conn_id: 'connection_info.uid',
      if_a: 'dst_endpoint.interface_name',
      ip_a: 'dst_endpoint.ip',
      port_a: { path: 'dst_endpoint.port', transform: 'to_int' },
      if_b: 'src_endpoint.interface_name',
      ip_b: 'src_endpoint.ip',
      port_b: { path: 'src_endpoint.port', transform: 'to_int' },
      bytes: { path: 'traffic.bytes_in', transform: 'to_int' },
    },
    unmapped_keep: ['duration'],
  },
  {
    template_id: 'fgt_traffic_forward',
    pack: 'fortigate',
    pack_version: 2,
    source_id: 'fgt01',
    vendor: 'Fortinet',
    product: 'FortiGate',
    class_uid: 4001,
    activity_id: 1,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' date='), S('date', 'word'), L(' time='), S('time', 'word'),
      L(' devname="'), S('devname', 'hostname'), L('" logid="'), S('logid', 'word'),
      L('" type="traffic" subtype="forward" level="'), S('level', 'enum', ['notice', 'warning', 'information']),
      L('" srcip='), S('srcip', 'ip'), L(' srcport='), S('srcport', 'port'),
      L(' dstip='), S('dstip', 'ip'), L(' dstport='), S('dstport', 'port'),
      L(' proto='), S('proto', 'int'), L(' action="'), S('action', 'enum', ['accept', 'deny', 'block']),
      L('" policyid='), S('policyid', 'int'), L(' service="'), S('service', 'word'),
      L('" sentbyte='), S('sentbyte', 'int'), L(' rcvdbyte='), S('rcvdbyte', 'int'),
    ],
    constants: {},
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      srcip: 'src_endpoint.ip',
      srcport: { path: 'src_endpoint.port', transform: 'to_int' },
      dstip: 'dst_endpoint.ip',
      dstport: { path: 'dst_endpoint.port', transform: 'to_int' },
      action: { path: 'action_id', enum: { accept: 1, deny: 2, block: 2 } },
      sentbyte: { path: 'traffic.bytes_out', transform: 'to_int' },
      rcvdbyte: { path: 'traffic.bytes_in', transform: 'to_int' },
      devname: 'metadata.product.name',
    },
    unmapped_keep: ['date', 'time', 'logid', 'level', 'proto', 'policyid', 'service'],
  },
  {
    template_id: 'cef_panos_traffic',
    pack: 'cef_generic',
    pack_version: 1,
    source_id: 'cef01',
    vendor: 'Palo Alto Networks',
    product: 'PAN-OS',
    class_uid: 4001,
    activity_id: 1,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' CEF:0|Palo Alto Networks|PAN-OS|'), S('ver', 'word'), L('|'), S('sig_id', 'word'),
      L('|'), S('name', 'text'), L('|'), S('cef_sev', 'int'),
      L('|src='), S('src', 'ip'), L(' spt='), S('spt', 'port'),
      L(' dst='), S('dst', 'ip'), L(' dpt='), S('dpt', 'port'),
      L(' proto='), S('proto', 'enum', ['TCP', 'UDP', 'ICMP']),
      L(' act='), S('act', 'enum', ['allow', 'deny', 'drop']),
      L(' duser='), S('duser', 'word'),
    ],
    constants: {},
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      src: 'src_endpoint.ip',
      spt: { path: 'src_endpoint.port', transform: 'to_int' },
      dst: 'dst_endpoint.ip',
      dpt: { path: 'dst_endpoint.port', transform: 'to_int' },
      proto: { path: 'connection_info.protocol_name', transform: 'lowercase' },
      act: { path: 'action_id', enum: { allow: 1, deny: 2, drop: 2 } },
      duser: 'actor.user.name',
      name: 'message',
    },
    unmapped_keep: ['ver', 'sig_id', 'cef_sev'],
  },
  {
    template_id: 'squid_access',
    pack: 'squid',
    pack_version: 1,
    source_id: 'proxy01',
    vendor: 'Squid',
    product: 'squid',
    class_uid: 4002,
    activity_id: 1,
    time_slot: 'epoch',
    severity_id: 1,
    tokens: [
      S('epoch', 'epoch_ts'), S('pad', 'ws'), S('elapsed', 'int'), L(' '), S('client', 'ip'),
      L(' '), S('result', 'word'), L('/'), S('status', 'int'), L(' '), S('bytes', 'int'),
      L(' '), S('method', 'enum', ['GET', 'POST', 'HEAD', 'CONNECT', 'PUT']),
      L(' '), S('url', 'word'), L(' '), S('ident', 'word'),
      L(' '), S('hier', 'word'), L('/'), S('peer', 'ip'), L(' '), S('mime', 'word'),
    ],
    constants: {},
    map: {
      epoch: { path: 'metadata.original_time', transform: 'ts_parse' },
      client: 'src_endpoint.ip',
      peer: 'dst_endpoint.ip',
      method: 'http_request.http_method',
      url: 'http_request.url.text',
      status: { path: 'http_response.code', transform: 'to_int' },
      bytes: { path: 'traffic.bytes_in', transform: 'to_int' },
    },
    unmapped_keep: ['pad', 'elapsed', 'result', 'ident', 'hier', 'mime'],
  },
  {
    template_id: 'pf_filterlog_tcp',
    pack: 'pfsense',
    pack_version: 1,
    source_id: 'pf01',
    vendor: 'Netgate',
    product: 'pfSense',
    class_uid: 4001,
    activity_id: 6,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' filterlog['), S('procid', 'int'), L(']: '), S('rulenr', 'int'),
      L(',,,'), S('ruleid', 'int'), L(','), S('iface', 'word'),
      L(',match,'), S('act', 'enum', ['pass', 'block']), L(','), S('dir', 'enum', ['in', 'out']),
      L(',4,0x0,,'), S('ttl', 'int'), L(','), S('ipid', 'int'),
      L(',0,DF,6,tcp,'), S('length', 'int'), L(','), S('srcip', 'ip'), L(','), S('dstip', 'ip'),
      L(','), S('srcport', 'port'), L(','), S('dstport', 'port'), L(',0,S,'), S('seq', 'int'),
      L(',,'), S('win', 'int'), L(',,mss;sackOK;TS'),
    ],
    constants: { 'connection_info.protocol_name': 'tcp' },
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      srcip: 'src_endpoint.ip',
      srcport: { path: 'src_endpoint.port', transform: 'to_int' },
      dstip: 'dst_endpoint.ip',
      dstport: { path: 'dst_endpoint.port', transform: 'to_int' },
      act: { path: 'action_id', enum: { pass: 1, block: 2 } },
    },
    unmapped_keep: ['procid', 'rulenr', 'ruleid', 'iface', 'dir', 'ttl', 'ipid', 'length', 'seq', 'win'],
  },
  {
    template_id: 'openvpn_auth_ok',
    pack: 'openvpn',
    pack_version: 1,
    source_id: 'vpn01',
    vendor: 'OpenVPN',
    product: 'OpenVPN',
    class_uid: 3002,
    activity_id: 1,
    pri_slot: 'pri',
    time_slot: 'ts',
    tokens: [
      L('<'), S('pri', 'int'), L('>'), S('ts', 'syslog3164_ts'), L(' '), S('host', 'hostname'),
      L(' openvpn['), S('procid', 'int'), L(']: user \''), S('user', 'word'),
      L('\' authenticated from '), S('peer_ip', 'ip'), L(':'), S('peer_port', 'port'),
    ],
    constants: { status_id: 1 },
    map: {
      ts: 'metadata.original_time',
      host: 'metadata.log_name',
      user: 'user.name',
      peer_ip: 'src_endpoint.ip',
      peer_port: { path: 'src_endpoint.port', transform: 'to_int' },
    },
    unmapped_keep: ['procid'],
  },
  {
    template_id: 'suricata_eve_alert',
    pack: 'suricata',
    pack_version: 1,
    source_id: 'ids01',
    vendor: 'OISF',
    product: 'Suricata',
    class_uid: 2004,
    activity_id: 1,
    time_slot: 'timestamp',
    severity_id: 4,
    tokens: [
      L('{"timestamp":"'), S('timestamp', 'iso8601_ts'), L('","flow_id":'), S('flow_id', 'int'),
      L(',"event_type":"alert","src_ip":"'), S('src_ip', 'ip'), L('","src_port":'), S('src_port', 'port'),
      L(',"dest_ip":"'), S('dest_ip', 'ip'), L('","dest_port":'), S('dest_port', 'port'),
      L(',"proto":"'), S('proto', 'enum', ['TCP', 'UDP']),
      L('","alert":{"signature":"'), S('signature', 'text'), L('","severity":'), S('sev', 'int'),
      L(',"signature_id":'), S('sig_id', 'int'), L('}}'),
    ],
    constants: {},
    map: {
      timestamp: 'metadata.original_time',
      src_ip: 'src_endpoint.ip',
      src_port: { path: 'src_endpoint.port', transform: 'to_int' },
      dest_ip: 'dst_endpoint.ip',
      dest_port: { path: 'dst_endpoint.port', transform: 'to_int' },
      proto: { path: 'connection_info.protocol_name', transform: 'lowercase' },
      signature: 'message',
      flow_id: 'connection_info.uid',
    },
    unmapped_keep: ['sev', 'sig_id'],
  },
];

/* ---------------- events ---------------- */

export interface EventFixture {
  event_uid: string;
  template_id: string;
  vars: string[];
  recv_ms: number;
  partition: number;
  parse_status?: ParseStatus;
  /** Set for quarantined lines that no template matched. */
  verbatim_raw?: string;
}

const T0 = 1789828262000; // Sep 19 2026 14:31:02 UTC, the spec's example timestamp

export const EVENTS: EventFixture[] = [
  {
    event_uid: '01K5HQX3M8Z4V7N2P0R6T9WXYA',
    template_id: 'asa_302013',
    recv_ms: T0,
    partition: 3,
    vars: ['166', 'Sep 19 14:31:02', 'fw01', 'outbound', '1234', 'outside', '203.0.113.5', '443',
      '203.0.113.5', '443', 'inside', '10.0.0.5', '52144', '198.51.100.7', '52144'],
  },
  {
    event_uid: '01K5HQX4B1C6D8E0F2G4H6J8K0',
    template_id: 'asa_302013',
    recv_ms: T0 + 1400,
    partition: 3,
    vars: ['166', 'Sep 19 14:31:03', 'fw01', 'outbound', '1235', 'outside', '93.184.216.34', '80',
      '93.184.216.34', '80', 'inside', '10.0.0.23', '51344', '198.51.100.7', '51344'],
  },
  {
    event_uid: '01K5HQX5C2D7E9F1G3H5J7K9M1',
    template_id: 'asa_302013',
    recv_ms: T0 + 2900,
    partition: 1,
    vars: ['166', 'Sep 19 14:31:05', 'fw01', 'inbound', '1236', 'outside', '198.51.100.23', '51422',
      '198.51.100.23', '51422', 'inside', '10.0.0.9', '22', '198.51.100.7', '22'],
  },
  {
    event_uid: '01K5HQXA7N3P5Q7R9S1T3V5W7X',
    template_id: 'asa_302014',
    recv_ms: T0 + 219000,
    partition: 3,
    vars: ['166', 'Sep 19 14:34:41', 'fw01', '1234', 'outside', '203.0.113.5', '443',
      'inside', '10.0.0.5', '52144', '0:03:39', '84210'],
  },
  {
    event_uid: '01K5HQX6D3E8F0G2H4J6K8M0N2',
    template_id: 'fgt_traffic_forward',
    recv_ms: T0 + 3000,
    partition: 0,
    vars: ['189', 'Sep 19 14:31:05', 'fgt01', '2026-09-19', '14:31:05', 'FG100F', '0000000013',
      'notice', '10.0.0.23', '51344', '142.250.183.14', '443', '6', 'accept', '7', 'HTTPS', '1420', '9331'],
  },
  {
    event_uid: '01K5HQX7E4F9G1H3J5K7M9N1P3',
    template_id: 'fgt_traffic_forward',
    recv_ms: T0 + 4100,
    partition: 0,
    vars: ['189', 'Sep 19 14:31:06', 'fgt01', '2026-09-19', '14:31:06', 'FG100F', '0000000013',
      'warning', '10.0.0.66', '44210', '45.83.22.9', '4444', '6', 'deny', '12', 'unknown', '0', '0'],
  },
  {
    event_uid: '01K5HQX8F5G0H2J4K6M8N0P2Q4',
    template_id: 'cef_panos_traffic',
    recv_ms: T0 + 7000,
    partition: 2,
    vars: ['134', 'Sep 19 14:31:09', 'cef01', '10.2', 'end', 'TRAFFIC', '3',
      '10.0.0.41', '49872', '93.184.216.34', '443', 'TCP', 'allow', 'r.menon'],
  },
  {
    event_uid: '01K5HQX9G6H1J3K5M7N9P1Q3R5',
    template_id: 'squid_access',
    recv_ms: T0 + 3417,
    partition: 1,
    vars: ['1789828265.417', '    ', '231', '10.0.0.66', 'TCP_MISS', '200', '14321', 'GET',
      'http://example.com/index.html', '-', 'HIER_DIRECT', '93.184.216.34', 'text/html'],
  },
  {
    event_uid: '01K5HQXB8P4Q6R8S0T2V4W6X8Y',
    template_id: 'squid_access',
    recv_ms: T0 + 5102,
    partition: 1,
    vars: ['1789828267.102', '   ', '1841', '10.0.0.41', 'TCP_TUNNEL', '200', '58210', 'CONNECT',
      'www.google.com:443', '-', 'HIER_DIRECT', '142.250.183.14', '-'],
  },
  {
    event_uid: '01K5HQXC9Q5R7S9T1V3W5X7Y9Z',
    template_id: 'pf_filterlog_tcp',
    recv_ms: T0 + 10000,
    partition: 2,
    vars: ['134', 'Sep 19 14:31:12', 'pf01', '12345', '5', '1000000103', 'igb0', 'block', 'in',
      '64', '54321', '60', '198.51.100.23', '10.0.0.9', '44321', '22', '1234567890', '64240'],
  },
  {
    event_uid: '01K5HQXD0R6S8T0V2W4X6Y8Z0A',
    template_id: 'openvpn_auth_ok',
    recv_ms: T0 + 13000,
    partition: 0,
    vars: ['38', 'Sep 19 14:31:15', 'vpn01', '8912', 'r.menon', '198.51.100.23', '51422'],
  },
  {
    event_uid: '01K5HQXE1S7T9V1W3X5Y7Z9A1B',
    template_id: 'suricata_eve_alert',
    recv_ms: T0 + 16000,
    partition: 2,
    vars: ['2026-09-19T14:31:18.442112+0000', '1846251', '203.0.113.77', '44122', '10.0.0.15', '445',
      'TCP', 'ET EXPLOIT SMB Remote Code Execution Attempt', '1', '2024217'],
  },
  // Scenario 5: firmware drift. The vendor appended a field, so nothing matches:
  // stored verbatim, parse_status raw_only, quarantined. Nothing is ever dropped.
  {
    event_uid: '01K5HQXF2T8V0W2X4Y6Z8A0B2C',
    template_id: '',
    recv_ms: T0 + 60000,
    partition: 3,
    parse_status: 'raw_only',
    vars: [],
    verbatim_raw:
      '<166>Sep 19 14:32:02 fw01 %ASA-6-302013: Built outbound TCP connection 1301 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52190 (198.51.100.7/52190) duration 0:00:00 user r.menon',
  },
  {
    event_uid: '01K5HQXG3V9W1X3Y5Z7A9B1C3D',
    template_id: '',
    recv_ms: T0 + 61200,
    partition: 3,
    parse_status: 'raw_only',
    vars: [],
    verbatim_raw:
      '<166>Sep 19 14:32:03 fw01 %ASA-6-302013: Built outbound TCP connection 1302 for outside:93.184.216.34/80 (93.184.216.34/80) to inside:10.0.0.23/51390 (198.51.100.7/51390) duration 0:00:00 user a.iyer',
  },
];

/** Quarantine clusters, output of Drain3 pre-masked clustering (spec 8.6). */
export const CLUSTERS: QuarantineCluster[] = [
  {
    cluster_id: 'cl_asa_302013_v2',
    source_id: 'fw01',
    sample_count: 412,
    first_seen: '2026-09-19T14:32:02Z',
    last_seen: '2026-09-19T14:38:44Z',
    drain_template:
      '<*> <*> fw01 %ASA-6-302013: Built outbound TCP connection <*> for outside:<*>/<*> (<*>/<*>) to inside:<*>/<*> (<*>/<*>) duration <*> user <*>',
    samples: [
      '<166>Sep 19 14:32:02 fw01 %ASA-6-302013: Built outbound TCP connection 1301 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52190 (198.51.100.7/52190) duration 0:00:00 user r.menon',
      '<166>Sep 19 14:32:03 fw01 %ASA-6-302013: Built outbound TCP connection 1302 for outside:93.184.216.34/80 (93.184.216.34/80) to inside:10.0.0.23/51390 (198.51.100.7/51390) duration 0:00:00 user a.iyer',
      '<166>Sep 19 14:32:07 fw01 %ASA-6-302013: Built inbound TCP connection 1303 for outside:198.51.100.23/51500 (198.51.100.23/51500) to inside:10.0.0.9/22 (198.51.100.7/22) duration 0:00:00 user svc_backup',
    ],
    proposal_id: 'pr_asa_302013_v5',
  },
  {
    cluster_id: 'cl_fgt_utm_webfilter',
    source_id: 'fgt01',
    sample_count: 57,
    first_seen: '2026-09-19T14:33:10Z',
    last_seen: '2026-09-19T14:39:01Z',
    drain_template:
      '<*> <*> fgt01 date=<*> time=<*> logid="<*>" type="utm" subtype="webfilter" srcip=<*> dstip=<*> hostname="<*>" action="<*>" catdesc="<*>"',
    samples: [
      '<189>Sep 19 14:33:10 fgt01 date=2026-09-19 time=14:33:10 logid="0316013056" type="utm" subtype="webfilter" srcip=10.0.0.66 dstip=45.83.22.9 hostname="ads.example.net" action="blocked" catdesc="Advertising"',
      '<189>Sep 19 14:33:22 fgt01 date=2026-09-19 time=14:33:22 logid="0316013056" type="utm" subtype="webfilter" srcip=10.0.0.23 dstip=93.184.216.34 hostname="example.com" action="passthrough" catdesc="Information Technology"',
    ],
  },
];

/* ---------------- demo console (spec 21.2) ---------------- */

export const SCENARIOS: DemoScenario[] = [
  {
    id: 'scn0', number: 0, title: 'One-command start', action_label: 'Check health',
    proves: 'The whole framework is one container the evaluator can start with a single command.',
    expected: 'Container reports healthy; the UI opens on port 6156 and Grafana at /grafana/.',
    link: { label: 'Container health', href: '/dashboard/demo' },
    cli: 'docker run -d --name aletheia -p 6156:6156 -p 26514:5514/udp -p 26514:5514/tcp docker.io/<namespace>/aletheia:1.0.0',
    requirements: ['k'], runnable: true,
  },
  {
    id: 'scn1', number: 1, title: 'Unified output', action_label: 'Start traffic',
    proves: 'Eight different source formats land in one table with identical OCSF columns.',
    expected: 'Events stream in from fw01, fgt01, cef01, proxy01, pf01, vpn01, ids01; one table shows them all.',
    link: { label: 'Events explorer', href: '/dashboard' },
    cli: 'docker exec aletheia aletheia-demo start-traffic --sources all --rate 500',
    requirements: ['b', 'c', 'f'], runnable: true,
  },
  {
    id: 'scn2', number: 2, title: 'Byte lineage', action_label: 'Open a lineage example',
    proves: 'Traceability is at byte level, not just an event id link.',
    expected: 'Clicking src_endpoint.ip highlights the exact bytes it came from in the reconstructed raw line.',
    link: { label: 'Lineage viewer', href: '/dashboard/lineage/01K5HQX3M8Z4V7N2P0R6T9WXYA' },
    cli: 'docker exec aletheia aletheia lineage --event 01K5HQX3M8Z4V7N2P0R6T9WXYA --json',
    requirements: ['d'], runnable: true,
  },
  {
    id: 'scn3', number: 3, title: 'Integrity and tamper detection', action_label: 'Run verify',
    proves: 'Stored events are tamper-evident: a byte changed behind Aletheia\'s back is caught.',
    expected: 'Verify passes. After Tamper one stored byte it fails and names the exact Merkle batch and event.',
    link: { label: 'Verify output', href: '/dashboard/demo' },
    cli: 'docker exec aletheia aletheia verify --source fw01 --last 15m --json',
    requirements: ['a'], runnable: true,
  },
  {
    id: 'scn3t', number: 3, title: 'Tamper one stored byte', action_label: 'Tamper a byte',
    proves: 'An attacker with database access cannot alter an event undetected.',
    expected: 'A ClickHouse mutation edits one stored variable. The next verify fails on that batch.',
    link: { label: 'Re-run verify above', href: '/dashboard/demo' },
    cli: 'docker exec aletheia aletheia-demo tamper --event 01K5HQX3M8Z4V7N2P0R6T9WXYA --byte 12',
    requirements: ['a'], runnable: true,
  },
  {
    id: 'scn4', number: 4, title: 'Storage economy', action_label: 'Storage report',
    proves: 'Keeping everything losslessly costs less than raw plus a normalized copy.',
    expected: 'Live ClickHouse figures comparing Aletheia against raw + normalized and against compressed raw.',
    link: { label: 'Storage report', href: '/dashboard/demo' },
    cli: 'docker exec aletheia aletheia-demo storage-report --json',
    requirements: ['h'], runnable: true,
  },
  {
    id: 'scn5', number: 5, title: 'Drift and gated onboarding', action_label: 'Trigger firmware drift',
    proves: 'A format change is detected, quarantined and onboarded instead of silently dropped.',
    expected: 'Drifted events appear as raw_only and quarantined; the Studio clusters them and proposes a template.',
    link: { label: 'Onboarding Studio', href: '/dashboard/studio' },
    cli: 'docker exec aletheia aletheia-demo drift --source fw01 --variant asa_302013_v2',
    requirements: ['e', 'i'], runnable: true,
  },
  {
    id: 'scn5b', number: 5, title: 'Gate rejection', action_label: 'Try a faulty template',
    proves: 'A parser that does not rebuild the original byte for byte cannot be approved.',
    expected: 'The gate rejects the proposal and shows the failing sample and the exact byte offset.',
    link: { label: 'Studio gate results', href: '/dashboard/studio' },
    cli: 'docker exec aletheia aletheia test-pack --pack /tmp/faulty.yaml --samples /data/quarantine/fw01 --json',
    requirements: ['i'], runnable: true,
  },
  {
    id: 'scn5c', number: 5, title: 'AI-assisted proposal (optional)', action_label: 'Ask AI on a cluster',
    proves: 'AI is useful but never trusted: its suggestion faces the same gate as a heuristic one.',
    expected: 'Suggestion labelled ai:<provider>/<model>, then shown passing or failing the gate. Needs a configured provider.',
    link: { label: 'Studio, Ask AI', href: '/dashboard/studio' },
    cli: 'docker exec aletheia aletheia-studio ask-ai --cluster cl_asa_302013_v2 --json',
    requirements: ['i'], runnable: true,
  },
  {
    id: 'scn6', number: 6, title: 'Replay diff, approval and backfill', action_label: 'Run replay diff',
    proves: 'The blast radius of a parser change is known before it goes live.',
    expected: 'Report of which events and fields change; after approval workers hot-reload and quarantined events become full.',
    link: { label: 'Studio replay diff', href: '/dashboard/studio' },
    cli: 'docker exec aletheia aletheia replay --source fw01 --from-version 4 --to-version 5 --last 5000 --json',
    requirements: ['e', 'i'], runnable: true,
  },
  {
    id: 'scn7', number: 7, title: 'Reach', action_label: 'Show sink feeds',
    proves: 'The same events reach the tools an organization already runs.',
    expected: 'Events visible in Loki with low-cardinality labels, plus live Kafka topic and CEF re-emit feeds.',
    link: { label: 'Grafana (Loki)', href: '/grafana/', external: true },
    cli: 'docker exec aletheia aletheia-demo sinks --show loki,kafka,cef',
    requirements: ['g'], runnable: true,
  },
  {
    id: 'scn8', number: 8, title: 'Throughput', action_label: 'Run benchmark',
    proves: 'Throughput scales with workers on the evaluator\'s own machine.',
    expected: 'Events/sec for 1, 2 and 4 workers, next to the reference numbers measured by the team.',
    link: { label: 'Benchmark output', href: '/dashboard/demo' },
    cli: 'docker exec aletheia aletheia bench --workers 1,2,4 --duration 60s --json',
    requirements: ['f'], runnable: true,
  },
  {
    id: 'scn9', number: 9, title: 'Air-gapped operation', action_label: 'Air-gap checklist',
    proves: 'Every scenario above passes with no network at all.',
    expected: 'docker save / docker load on a disconnected machine; all scenarios pass; no outbound connections.',
    link: { label: 'Settings, air-gap state', href: '/dashboard/settings' },
    cli: 'docker save docker.io/<namespace>/aletheia:1.0.0 | gzip > aletheia.tgz   # then docker load on the air-gapped host',
    requirements: ['j'], runnable: false,
  },
  {
    id: 'scn10', number: 10, title: 'Bring your own log', action_label: 'How to send a line',
    proves: 'Any source works: known formats normalize at once, unknown ones are onboarded live.',
    expected: 'Known formats appear as full in the explorer; unknown ones appear as a new quarantine cluster in the Studio.',
    link: { label: 'Onboarding Studio', href: '/dashboard/studio' },
    cli: 'logger -n localhost -P 26514 -d "<166>Sep 19 14:31:02 fw01 %ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/443 (203.0.113.5/443) to inside:10.0.0.5/52144 (198.51.100.7/52144)"',
    requirements: ['b', 'e'], runnable: false,
  },
];

/** sha256 of each reconstructed raw line. Generated, see frontend/README.md. */
export const RAW_SHA256: Record<string, string> = {
  "01K5HQX3M8Z4V7N2P0R6T9WXYA": "f7ba851094c67354605205f8a900ea04bb5930a079d8a986bf9f1c3a660e12d6",
  "01K5HQX4B1C6D8E0F2G4H6J8K0": "23fa15cf1f80408211466ec9a83be4318678f6c831521a730dd3be9ae6e626fc",
  "01K5HQX5C2D7E9F1G3H5J7K9M1": "cb8399e68e9c8c2bbd1e4cec738fd96c651a318e3c3cda7604b8fedaa2e19465",
  "01K5HQXA7N3P5Q7R9S1T3V5W7X": "29ccbadf5d08cf1194b990a330c8ff10fadc3a9a242521101eb915d6cd41430c",
  "01K5HQX6D3E8F0G2H4J6K8M0N2": "e719549e381dedbe7406102f1c58fb487d56deb561d5b3e5dd8e996492084631",
  "01K5HQX7E4F9G1H3J5K7M9N1P3": "f35db09be49f4bec60ac1f1804013e5acd3952b7925a586d4125da8d14e92791",
  "01K5HQX8F5G0H2J4K6M8N0P2Q4": "31cf6825ef778f25400ee527ac32497d01f5ecea9bf3a8e230a1598425ff34cc",
  "01K5HQX9G6H1J3K5M7N9P1Q3R5": "f5d2f2382c80529162c62dee0eb3808ee8f3121e293cca7cd1d31501ade59ff4",
  "01K5HQXB8P4Q6R8S0T2V4W6X8Y": "43bccc426907292f831c3bb3d290051296d375f02b39f9bef4250aa92bf55e03",
  "01K5HQXC9Q5R7S9T1V3W5X7Y9Z": "903e5bd8df0139d99a4deebc836de1c77614d1fa6b828367b50ab0c5c0177f6e",
  "01K5HQXD0R6S8T0V2W4X6Y8Z0A": "f076bcaeff552f33334181cfd4803aefaa468d9f14b29ddf0357af011cd724f4",
  "01K5HQXE1S7T9V1W3X5Y7Z9A1B": "f1283c1e9c204ebea2953a2fff86a76a142f86412e971c9397c395c54f23e8cd",
  "01K5HQXF2T8V0W2X4Y6Z8A0B2C": "76de1b69ccc7a118c66bcede12e2fed4630788febd59710b14f09ea514d148a6",
  "01K5HQXG3V9W1X3Y5Z7A9B1C3D": "6564b9336ccce4e9b80f3f6382764b2a62e3346596ba6f6b431077eb2832a75b",
};
