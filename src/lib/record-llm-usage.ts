import { after } from 'next/server';
import { recordLlmUsage } from './db';
import type { LlmCallUsage, LlmUsagePhase } from './llm-usage';

// Next.js 托管响应后的工作生命周期；不能用无人等待的写库 Promise。
export function recordUsageAfterResponse(phase: LlmUsagePhase): (call: LlmCallUsage) => void {
  return (call) => {
    after(() => recordLlmUsage({ phase, ...call }));
  };
}
