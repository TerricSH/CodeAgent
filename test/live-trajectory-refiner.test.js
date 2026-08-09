'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    parseTrajectory,
    refineFromLiveTrajectories,
} = require('../skill-refinement/live-trajectory-refiner');

function fixtureRecord(step, ocr, decision, violation = null) {
    return {
        step,
        observation: {
            sha256: `hash-${step}`,
            ocrText: ocr,
            hints: [],
            save: { scripts: [{ scene: 'scene2.script', si: 78 }] },
        },
        decision,
        attempts: violation ? [{ decision, violation }] : [{ decision, violation: null }],
    };
}

test('live trajectory evidence preserves real actions and rejected decisions', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-refiner-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const trajectory = path.join(directory, 'trajectory.jsonl');
    const records = [
        fixtureRecord(0, 'Exarnine Talk Move Present', { action: 'key', key: 'ENTER' }, 'menu'),
        fixtureRecord(1, 'Exarnine Talk Move Present', { action: 'click', x: 175, y: 278 }),
    ];
    fs.writeFileSync(trajectory, `${records.map(JSON.stringify).join('\n')}\n`, 'utf8');

    const parsed = parseTrajectory(trajectory);
    assert.equal(parsed.recordCount, 2);
    assert.equal(parsed.steps[0].checkpoint, 'scene2.script:78');
    assert.equal(parsed.steps[0].rejectedAttempts[0].violation, 'menu');

    let reflectedMessages;
    const model = {
        async complete(messages) {
            reflectedMessages = messages;
            return JSON.stringify({
                diagnosis: ['调查菜单被误判'],
                successfulPatterns: ['OCR 坐标点击有效'],
                changes: ['增加菜单守卫'],
                candidateSkillMarkdown: [
                    '---',
                    'name: pywright-headless-player',
                    'description: 测试',
                    '---',
                    '',
                    '# 候选 Skill',
                ].join('\n'),
            });
        },
    };
    const result = await refineFromLiveTrajectories({
        model,
        skill: '---\nname: pywright-headless-player\n---\n# 当前 Skill',
        task: '真实操作游戏',
        trajectoryFiles: [trajectory],
    });
    assert.match(reflectedMessages[1].content, /Exarnine Talk Move Present/);
    assert.match(result.reflection.candidateSkillMarkdown, /# 候选 Skill/);
});
