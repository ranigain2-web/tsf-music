#!/usr/bin/env python3
"""TSF CI watcher — poll GitHub Actions runs; on failure, dump job logs.

This is the autonomous-fix loop's eyes: the agent runs this script, reads the
failure tail, patches the repo, pushes, and repeats until green.

Usage:
  watch:    python3 scripts/watch-ci.py [run_id]      # waits for completion
  logs:     python3 scripts/watch-ci.py --logs RUN_ID # dumps failed job logs
"""
import json
import os
import sys
import time
import urllib.request

REPO = 'mua47105-hue/TSF-MUSIC'
TOKEN = os.environ['GH_TOKEN']
API = f'https://api.github.com/repos/{REPO}'


def req(url, raw=False):
    r = urllib.request.Request(url, headers={'Authorization': f'token {TOKEN}'})

    class NoAuthRedirect(urllib.request.HTTPRedirectHandler):
        """The Actions logs endpoint 302s to a signed blob URL — sending our
        Authorization header there gets rejected (403 signature error), so we
        strip it on redirect."""
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            strip = urllib.request.Request(newurl, method='GET')
            return strip

    opener = urllib.request.build_opener(NoAuthRedirect())
    with opener.open(r) as resp:
        data = resp.read()
        return data if raw else json.loads(data)


def wait_run(run_id: int, timeout_s: int = 1500) -> dict:
    """Block until a run completes; return the run JSON."""
    start = time.time()
    while time.time() - start < timeout_s:
        run = req(f'{API}/actions/runs/{run_id}')
        if run['status'] == 'completed':
            return run
        time.sleep(15)
    raise TimeoutError(f'run {run_id} not completed in {timeout_s}s')


def dump_logs(run_id: int):
    """Download logs for every failed job of a run."""
    jobs = req(f'{API}/actions/runs/{run_id}/jobs')
    for job in jobs.get('job_jobs', jobs.get('jobs', [])):
        flag = '❌' if job['conclusion'] == 'failure' else '✔'
        print(f"{flag} {job['name']} → {job['conclusion']}")
        if job['conclusion'] == 'failure':
            try:
                log_url = req(f"{API}/actions/jobs/{job['id']}/logs", raw=True)
                text = log_url.decode('utf-8', errors='replace')
                lines = text.split('\n')
                # print the last 90 lines that carry signal (skip empty)
                tail = [l for l in lines if l.strip()][-90:]
                print('\n'.join(tail))
                print('─' * 70)
            except Exception as e:
                print(f'(log fetch failed: {e})')


if __name__ == '__main__':
    if sys.argv[1] == '--logs':
        dump_logs(int(sys.argv[2]))
        sys.exit(0)

    if len(sys.argv) > 1:
        target = int(sys.argv[1])
    else:
        runs = req(f'{API}/actions/runs?per_page=10')
        live = [r for r in runs['workflow_runs'] if r['status'] != 'completed']
        if not live:
            print('no live runs; latest:')
            for r in runs['workflow_runs'][:5]:
                print(f"  {r['id']}  {r['name']:<20} {r.get('conclusion')}")
            sys.exit(0)
        target = live[0]['id']

    run = req(f'{API}/actions/runs/{target}')
    print(f"watching run {target}: {run['name']} ({run['status']})")
    run = wait_run(target)
    print(f"\n═══ {run['name']} → {run['conclusion'].upper()} ═══")
    if run['conclusion'] != 'success':
        dump_logs(target)
        sys.exit(1)
