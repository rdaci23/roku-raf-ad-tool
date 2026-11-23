import { networkInterfaces } from 'node:os';

export function detectLanIp(): string {
  const explicitIp = process.env.LAN_HOST_IP?.trim();
  if (explicitIp) {
    return explicitIp;
  }
  const nets = networkInterfaces();
  const candidates: string[] = [];

  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    // Deprioritize docker/bridge virtual interfaces
    const isVirtual = /^(docker|br-|veth|virbr|tun|tap|lo)/i.test(name);
    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) {
        if (isVirtual) {
          candidates.push(net.address);
        } else {
          candidates.unshift(net.address);
        }
      }
    }
  }

  return candidates[0] ?? '127.0.0.1';
}
