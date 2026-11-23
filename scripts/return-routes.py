#!/usr/bin/env python3
"""Run once from a Linux node; schedule with cron. Requires traceroute and Python 3."""
import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request


def parse_hops(output):
    hops = []
    for line in output.splitlines():
        match = re.match(r'^\s*(\d+)\s+(.+)$', line)
        if not match:
            continue
        ttl, rest = int(match[1]), match[2]
        if not 1 <= ttl <= 30:
            continue
        address = None
        for token in rest.split():
            try:
                address = str(ipaddress.ip_address(token))
                break
            except ValueError:
                pass
        asn = re.search(r'\[AS(\d+)\]', rest)
        delay = re.search(r'(\d+(?:\.\d+)?)\s*ms', rest)
        hops.append({'ttl': ttl, 'ip': address,
                     'asn': int(asn[1]) if asn and int(asn[1]) > 0 else None,
                     'rtt': float(delay[1]) if delay else None})
    return hops


def probe(carrier, target):
    route = {'carrier': carrier, 'target': target, 'status': 'error', 'error': '', 'hops': []}
    try:
        # Numeric addresses only: no shell expansion or DNS destination changes.
        ipaddress.IPv4Address(target)
        result = subprocess.run(['traceroute', '-4', '-n', '-A', '-q', '1', '-w', '1', '-m', '30', target],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=90, check=False)
        route['hops'] = parse_hops(result.stdout)
        if result.returncode:
            route['error'] = (result.stderr.strip() or 'traceroute failed')[:500]
        else:
            route['status'] = 'ok' if any(h['ip'] == target for h in route['hops']) else 'incomplete'
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        route['error'] = str(exc)[:500]
    return route


def load_agent_config(path):
    # Match the Agent's KEY="value" parser; never execute/source this file.
    values = {}
    with open(path, encoding='utf-8') as source:
        for line in source:
            key, sep, value = line.strip().partition('=')
            if sep and not key.startswith('#'):
                values[key.strip()] = value.strip().strip('"')
    worker = urllib.parse.urlsplit(values['WORKER_URL'])
    return {'worker': urllib.parse.urlunsplit((worker.scheme, worker.netloc, '', '', '')),
            'server_id': values.get('SERVER_ID', ''), 'secret': values['SECRET'],
            'ua': values.get('UA') or 'cfsm',
            'targets': {'telecom': '219.141.136.12', 'unicom': '202.106.50.1',
                        'mobile': '221.179.155.161'}}


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--config', help='JSON config, mode 600')
    source.add_argument('--agent-config', help='Existing Agent config.conf')
    args = parser.parse_args()
    config_path = args.agent_config or args.config
    if args.agent_config:
        config = load_agent_config(config_path)
        if not config['server_id']:
            print('Waiting for Agent auto discovery to assign a node ID')
            return
    else:
        with open(config_path, encoding='utf-8') as source:
            config = json.load(source)
    if not shutil.which('traceroute'):
        raise ValueError('Install the Linux traceroute package first (must support -A).')
    if urllib.parse.urlsplit(config['worker']).scheme != 'https':
        raise ValueError('worker must use HTTPS')
    for carrier in ('telecom', 'unicom', 'mobile'):
        ipaddress.IPv4Address(config['targets'][carrier])
    # Prevent overlapping cron invocations on the same node/config.
    with open(os.path.abspath(config_path) + '.return-routes.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        routes = [probe(c, config['targets'][c]) for c in ('telecom', 'unicom', 'mobile')]
        url = config['worker'].rstrip('/') + '/return-routes?' + urllib.parse.urlencode({'id': config['server_id']})
        request = urllib.request.Request(url, data=json.dumps({'routes': routes}).encode(),
                                         headers={'Authorization': 'Bearer ' + config['secret'], 'Content-Type': 'application/json',
                                                  'User-Agent': config.get('ua', 'cfsm')}, method='POST')
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError('Upload failed')
        print('Three carrier return routes uploaded')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Return route probe failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)
