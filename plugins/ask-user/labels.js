// ask-user 插件自带的交互文案；随插件存在/移除，不污染核心输出层的 labels.json。
// 通过 collect 载荷（question.labels）传给交互收集器，收集器仅在缺省时用自身中性兜底。
module.exports = {
    title: '请回答',
    custom: '自定义…',
    answer: '你的回答',
    arrowsHint: '(↑/↓ 选择，回车确认)',
    numberHint: '(输入编号选择)',
    numberFreeHint: '(输入编号选择，或直接输入你的意见)',
    cancelled: '(用户取消回答)',
};
