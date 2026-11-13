// English follows the console's source-text keys; explicit entries keep trigger labels readable.
export const designGoalsEn: Record<string, string> = {
  'target-failing': 'Failing target', 'target-unmeasured': 'Target needs a measurement',
  'gap-unowned': 'Gap without an order', 'idle-capacity': 'Idle capacity',
};
export const designGoalsZh: Record<string, string> = {
  'target-failing': '指标未达标', 'target-unmeasured': '指标缺少测量',
  'gap-unowned': '缺口尚无工单', 'idle-capacity': '产能空闲',
  'Structured measurement': '结构化测量', 'Systems': '系统', 'Measuring': '测量中',
  'Due': '待测量', 'Measurement ok': '测量成功', 'Measurement failed': '测量失败',
  'Last attempt': '最近尝试', 'Result': '结果', 'Measure now': '立即测量',
  'Measure {id} now': '立即测量 {id}', 'No structured measurement': '未配置结构化测量',
  'Related rules': '相关规则', 'Related gaps': '相关缺口',
  'No open milestone goals.': '没有待处理的里程碑目标。',
  'Goal drafts follow policy and count toward the daily draft allowance.': '目标草拟遵循策略，并计入每日草拟额度。',
  'JSON object with argv, timeout_minutes, value and when; null disables measurement.': 'JSON 对象包含 argv、timeout_minutes、value 和 when；null 表示禁用测量。',
};
