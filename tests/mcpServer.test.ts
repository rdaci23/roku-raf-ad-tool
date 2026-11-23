import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_ENTRY = join(ROOT, 'src', 'mcp', 'server.ts');

function runMcpSession(messages: unknown[], useContentLengthFraming: boolean): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', MCP_ENTRY], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses: Array<Record<string, unknown>> = [];
    let rawOut = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      rawOut = Buffer.concat([rawOut, chunk]);

      while (rawOut.length > 0) {
        const str = rawOut.toString('utf8');
        if (str.startsWith('Content-Length:')) {
          const sep = rawOut.indexOf('\r\n\r\n');
          if (sep === -1) break;
          const hdr = rawOut.subarray(0, sep).toString('utf8');
          const m = hdr.match(/Content-Length:\s*(\d+)/i);
          const len = m ? Number.parseInt(m[1], 10) : 0;
          if (rawOut.length < sep + 4 + len) break;
          const body = rawOut.subarray(sep + 4, sep + 4 + len).toString('utf8');
          rawOut = rawOut.subarray(sep + 4 + len);
          responses.push(JSON.parse(body));
        } else {
          const nl = rawOut.indexOf('\n');
          if (nl === -1) break;
          const line = rawOut.subarray(0, nl).toString('utf8').trim();
          rawOut = rawOut.subarray(nl + 1);
          if (line) responses.push(JSON.parse(line));
        }
      }

      if (responses.length >= messages.filter((m) => (m as { id?: unknown }).id !== undefined).length) {
        child.kill();
        resolve(responses);
      }
    });

    child.on('error', reject);
    setTimeout(() => {
      child.kill();
      resolve(responses);
    }, 6000);

    for (const msg of messages) {
      const json = JSON.stringify(msg);
      if (useContentLengthFraming) {
        child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
      } else {
        child.stdin.write(`${json}\n`);
      }
    }
  });
}

describe('MCP Stdio Server (Newline & Content-Length Framing)', () => {
  it('handles initialize, tools/list, and tools/call over Content-Length framed stdio', async () => {
    const responses = await runMcpSession(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'audit_vendor_ad_url',
            arguments: {
              url: 'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/roku&rdid=ROKU_ADS_TRACKING_ID&idtype=rida&is_lat=ROKU_ADS_LIMIT_TRACKING&correlator=ROKU_ADS_CACHE_BUSTER&us_privacy=1YNN',
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'generate_raf_brightscript',
            arguments: {
              mode: 'csai-skippable',
              adTagOrStreamUrl: 'https://ads.example.com/skippable.xml',
            },
          },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'scan_roku_channel_repo',
            arguments: {
              path: join(ROOT, 'roku-channel'),
            },
          },
        },
      ],
      true
    );

    expect(responses).toHaveLength(5);
    expect((responses[0].result as { serverInfo: { name: string } }).serverInfo.name).toBe('roku-raf-ad-tool');

    const toolsList = (responses[1].result as { tools: Array<{ name: string }> }).tools;
    expect(toolsList.length).toBeGreaterThanOrEqual(13);

    const auditContent = JSON.parse(
      (responses[2].result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(auditContent.score).toBe(100);

    const brsContent = JSON.parse(
      (responses[3].result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(brsContent.code).toContain('skipOverlayNode');

    const scanContent = JSON.parse(
      (responses[4].result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(scanContent.rafReady).toBe(true);
    expect(scanContent.score).toBe(100);
  });

  it('handles newline-delimited JSON-RPC framing cleanly', async () => {
    const responses = await runMcpSession(
      [
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'inspect_stream_manifest',
            arguments: {
              text: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\nseg1.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5.0,\nad1.ts\n#EXT-X-ENDLIST\n',
            },
          },
        },
      ],
      false
    );

    expect(responses).toHaveLength(2);
    const manifestRes = JSON.parse(
      (responses[1].result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(manifestRes.format).toBe('HLS');
    expect(manifestRes.adCues).toHaveLength(1);
  });
});
