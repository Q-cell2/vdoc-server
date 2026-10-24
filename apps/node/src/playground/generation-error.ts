export function generationError(previous: string, message: string): string {
  if (/^Generation stopped:/.test(message)) {
    return previous || '错误：GENERATION_FAILED: 本轮生成未完成，服务未提供更具体原因。请先检查文档和工具记录，再重试未完成部分。';
  }
  return '错误：' + message;
}
