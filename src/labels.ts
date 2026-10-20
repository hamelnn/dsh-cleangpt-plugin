/** Labels shared by Host model metadata and the browser UI. */
export const effortLabels: Record<string, string> = { none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极高' };
export const speedLabels: Record<string, string> = { auto: '自动', default: '标准', fast: '快速', ultrafast: '极速', priority: '优先', flex: '弹性', scale: '规模化' };
export const effortLabel = (id: string) => effortLabels[id] ?? id;
export const speedLabel = (id: string) => speedLabels[id] ?? id;
