/**
 * CI configuration audit tests.
 *
 * Verifies that the GitHub Actions workflows have proper safeguards:
 * - timeout-minutes on all jobs (prevents 6-hour hangs)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const WORKFLOWS_DIR = resolve(__dirname, '../../.github/workflows');

/**
 * Extract job blocks from a GitHub Actions workflow YAML.
 * Returns a map of job name -> job block content.
 */
function extractJobBlocks(content: string): Record<string, string> {
  const lines = content.split('\n');
  const jobs: Record<string, string> = {};

  let inJobs = false;
  let currentJob: string | null = null;
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    // New job definition: exactly 2-space indent + word + colon
    if (/^ {2}\w[\w-]*:\s*$/.test(line)) {
      // Save previous job
      if (currentJob) {
        jobs[currentJob] = currentBlock.join('\n');
      }
      currentJob = line.trim().replace(':', '');
      currentBlock = [];
      continue;
    }

    // Non-indented line ends the jobs section
    if (currentJob && /^\S/.test(line)) {
      jobs[currentJob] = currentBlock.join('\n');
      currentJob = null;
      break;
    }

    if (currentJob) {
      currentBlock.push(line);
    }
  }

  // Save last job
  if (currentJob) {
    jobs[currentJob] = currentBlock.join('\n');
  }

  return jobs;
}

describe('test.yml safeguards', () => {
  const filepath = resolve(WORKFLOWS_DIR, 'test.yml');

  it('workflow file exists', () => {
    expect(existsSync(filepath)).toBe(true);
  });

  it('all jobs have timeout-minutes set', () => {
    const content = readFileSync(filepath, 'utf-8');
    const jobs = extractJobBlocks(content);

    expect(Object.keys(jobs).length).toBeGreaterThan(0);

    for (const [jobName, jobBlock] of Object.entries(jobs)) {
      expect(
        jobBlock.includes('timeout-minutes'),
        `Job "${jobName}" is missing timeout-minutes — a hanging test will block CI for up to 6 hours`,
      ).toBe(true);
    }
  });
});

describe('maestro.yml safeguards', () => {
  const filepath = resolve(WORKFLOWS_DIR, 'maestro.yml');

  it('has timeout-minutes on all jobs if it exists', () => {
    if (!existsSync(filepath)) return;

    const content = readFileSync(filepath, 'utf-8');
    const jobs = extractJobBlocks(content);

    for (const [jobName, jobBlock] of Object.entries(jobs)) {
      expect(
        jobBlock.includes('timeout-minutes'),
        `Job "${jobName}" in maestro.yml is missing timeout-minutes`,
      ).toBe(true);
    }
  });
});
