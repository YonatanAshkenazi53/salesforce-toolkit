// Debug Story module — parses Salesforce flow debug logs into human-readable narratives

const DebugStory = (() => {
  const ELEMENT_LABELS = {
    Assignment: 'Assignment',
    Decision: 'Decision',
    RecordCreate: 'Create Record',
    RecordUpdate: 'Update Record',
    RecordDelete: 'Delete Record',
    RecordLookup: 'Get Records',
    Loop: 'Loop',
    Screen: 'Screen',
    ActionCall: 'Action',
    SubFlow: 'Subflow',
    Wait: 'Wait / Pause'
  };

  const ELEMENT_ICONS = {
    Assignment: '📋',
    Decision: '🔀',
    RecordCreate: '📝',
    RecordUpdate: '✏️',
    RecordDelete: '🗑',
    RecordLookup: '🔍',
    Loop: '🔁',
    Screen: '🖥',
    ActionCall: '🎬',
    SubFlow: '📞',
    Wait: '⏳'
  };

  function parseLog(rawLog) {
    const lines = rawLog.split('\n').map(l => l.trim()).filter(l => l.startsWith('FLOW_'));
    if (lines.length === 0) return null;

    // Split into per-interview sections
    const interviews = [];
    let current = null;

    for (const line of lines) {
      const parts = line.split('|');
      const eventType = parts[0];

      if (eventType === 'FLOW_START_INTERVIEW_BEGIN') {
        const flowApiName = parts[3] || '';
        const flowLabel = parts[4] || parts[3] || 'Unknown Flow';
        const timestamp = parts[1] || '';
        current = {
          flowApiName,
          flowLabel,
          timestamp,
          lines: [line],
          elements: [],
          stack: [],
          stats: { created: 0, updated: 0, deleted: 0, queried: 0, subflows: 0 }
        };
        interviews.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }

    // Parse each interview
    return interviews.map(interview => parseInterview(interview));
  }

  function parseInterview(interview) {
    const steps = [];
    const stack = [];
    let stepNum = 0;
    let currentStep = null;

    for (const line of interview.lines) {
      const parts = line.split('|');
      const eventType = parts[0];

      switch (eventType) {
        case 'FLOW_START_INTERVIEW_BEGIN': {
          const label = parts[4] || parts[3] || 'Unknown Flow';
          const ts = parseTimestamp(parts[1]);
          steps.push({ type: 'start', label, timestamp: ts });
          break;
        }
        case 'FLOW_ELEMENT_BEGIN': {
          const elementType = parts[3] || '';
          const elementLabel = parts[4] || '';
          stack.push({ elementType, elementLabel, details: [], stepNum: ++stepNum });
          currentStep = stack[stack.length - 1];
          break;
        }
        case 'FLOW_ELEMENT_END': {
          if (stack.length > 0) {
            const ended = stack.pop();
            const elementType = parts[3] || ended.elementType;
            const elementLabel = parts[4] || ended.elementLabel;
            steps.push({
              type: 'element',
              stepNum: ended.stepNum,
              elementType,
              elementLabel,
              details: ended.details
            });
            // Track stats
            if (elementType === 'RecordCreate') interview.stats.created++;
            if (elementType === 'RecordUpdate') interview.stats.updated++;
            if (elementType === 'RecordDelete') interview.stats.deleted++;
            if (elementType === 'RecordLookup') interview.stats.queried++;
            currentStep = stack.length > 0 ? stack[stack.length - 1] : null;
          }
          break;
        }
        case 'FLOW_RULE_DETAIL': {
          const label = parts[3] || '';
          const result = parts[4] || '';
          const path = parts[5] || '';
          const detail = { type: 'rule', label, result };
          if (path) detail.path = path;
          if (currentStep) currentStep.details.push(detail);
          else steps.push({ type: 'detail', detail });
          break;
        }
        case 'FLOW_ASSIGNMENT_DETAIL': {
          const variable = parts[3] || '';
          const operator = parts[4] || '=';
          const value = parts[5] || '';
          const detail = { type: 'assignment', variable, value };
          if (currentStep) currentStep.details.push(detail);
          else steps.push({ type: 'detail', detail });
          break;
        }
        case 'FLOW_LOOP_DETAIL': {
          const n = parts[3] || '';
          const variable = parts[4] || '';
          const value = parts[5] || '';
          const detail = { type: 'loop', n, variable, value };
          if (currentStep) currentStep.details.push(detail);
          break;
        }
        case 'FLOW_SUBFLOW_DETAIL': {
          const subflowName = parts[3] || '';
          const subflowLabel = parts[4] || subflowName;
          interview.stats.subflows++;
          const detail = { type: 'subflow', label: subflowLabel, name: subflowName };
          if (parts[5]) detail.input = parts[5];
          if (currentStep) currentStep.details.push(detail);
          else steps.push({ type: 'subflow_call', detail });
          break;
        }
        case 'FLOW_BULK_ELEMENT_BEGIN': {
          const label = parts[4] || parts[3] || '';
          steps.push({ type: 'bulk_begin', label });
          break;
        }
        case 'FLOW_BULK_ELEMENT_END': {
          const label = parts[4] || parts[3] || '';
          steps.push({ type: 'bulk_end', label });
          break;
        }
        case 'FLOW_ACTIONCALL_DETAIL': {
          const actionLabel = parts[3] || '';
          const result = parts[4] || '';
          const detail = { type: 'actioncall', label: actionLabel, result };
          if (currentStep) currentStep.details.push(detail);
          break;
        }
        case 'FLOW_SCREEN_FIELD_DETAIL': {
          const fieldLabel = parts[3] || '';
          const value = parts[4] || '';
          const detail = { type: 'screen_field', label: fieldLabel, value };
          if (currentStep) currentStep.details.push(detail);
          break;
        }
        case 'FLOW_END': {
          steps.push({ type: 'end' });
          break;
        }
        case 'FLOW_START_SCHEDULED_PATHS': {
          steps.push({ type: 'scheduled' });
          break;
        }
      }
    }

    return {
      flowLabel: interview.flowLabel,
      timestamp: steps[0]?.timestamp || '',
      steps,
      stats: interview.stats
    };
  }

  function parseTimestamp(raw) {
    if (!raw) return '';
    // Format: 19:30:10.0 (0)
    const m = raw.match(/(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : raw.substring(0, 20);
  }

  function renderStoryHTML(parsedInterviews) {
    if (!parsedInterviews || parsedInterviews.length === 0) return '';
    let html = '';

    for (let i = 0; i < parsedInterviews.length; i++) {
      const interview = parsedInterviews[i];
      const isNested = i > 0;
      html += `<div class="story-interview ${isNested ? 'story-nested' : ''}">`;
      if (isNested) {
        html += `<div class="story-nested-label">└── ▶ ${escHtml(interview.flowLabel)} (called as subflow)</div>`;
      }
      html += `<div class="story-header">`;
      html += `<div class="story-divider">════════════════════════════════════════════</div>`;
      html += `<div class="story-title">📖 Flow Execution Story: "${escHtml(interview.flowLabel)}"</div>`;
      if (interview.timestamp) {
        html += `<div class="story-meta">Ran at: ${escHtml(interview.timestamp)}</div>`;
      }
      html += `<div class="story-divider">════════════════════════════════════════════</div>`;
      html += `</div>`;

      html += `<div class="story-steps">`;
      for (const step of interview.steps) {
        html += renderStep(step);
      }
      html += `</div>`;

      const s = interview.stats;
      html += `<div class="story-footer">`;
      html += `<div class="story-divider">════════════════════════════════════════════</div>`;
      html += `<div class="story-stat">Total elements executed: ${countElements(interview.steps)}</div>`;
      html += `<div class="story-stat">Subflows called: ${s.subflows}</div>`;
      html += `<div class="story-stat">Records created: ${s.created} | Updated: ${s.updated} | Deleted: ${s.deleted} | Queried: ${s.queried}</div>`;
      html += `</div>`;
      html += `</div>`;
    }
    return html;
  }

  function countElements(steps) {
    return steps.filter(s => s.type === 'element').length;
  }

  function renderStep(step) {
    switch (step.type) {
      case 'start':
        return `<div class="story-step story-start">▶ Flow started: <strong>${escHtml(step.label)}</strong></div>`;
      case 'end':
        return `<div class="story-step story-end">⏹ Flow finished</div>`;
      case 'scheduled':
        return `<div class="story-step">📅 Scheduled path triggered</div>`;
      case 'bulk_begin':
        return `<div class="story-step story-detail">  ⚡ Bulk operation started: ${escHtml(step.label)}</div>`;
      case 'bulk_end':
        return `<div class="story-step story-detail">  ⚡ Bulk operation completed: ${escHtml(step.label)}</div>`;
      case 'subflow_call':
        return `<div class="story-step story-detail">  📞 Called subflow: "${escHtml(step.detail.label)}"</div>`;
      case 'detail':
        return renderDetailLine(step.detail, '');
      case 'element': {
        const icon = ELEMENT_ICONS[step.elementType] || '▪';
        const humanLabel = ELEMENT_LABELS[step.elementType] || step.elementType;
        let html = `<div class="story-step story-element">`;
        html += `  <span class="story-step-num">${step.stepNum}.</span> ${icon} <strong>${humanLabel}</strong> — "${escHtml(step.elementLabel)}"`;
        html += `</div>`;
        for (const detail of step.details) {
          html += renderDetailLine(detail, '   ');
        }
        return html;
      }
      default:
        return '';
    }
  }

  function renderDetailLine(detail, indent) {
    if (!detail) return '';
    switch (detail.type) {
      case 'rule': {
        let html = `<div class="story-step story-detail">${indent}  ↳ Condition "${escHtml(detail.label)}" evaluated to: <strong>${escHtml(detail.result)}</strong></div>`;
        if (detail.path) html += `<div class="story-step story-detail">${indent}  ↳ Took path: "${escHtml(detail.path)}"</div>`;
        return html;
      }
      case 'assignment':
        return `<div class="story-step story-detail">${indent}  ✏ Set ${escHtml(detail.variable)} = "${escHtml(detail.value)}"</div>`;
      case 'loop':
        return `<div class="story-step story-detail">${indent}  🔁 Loop iteration ${escHtml(detail.n)}: ${escHtml(detail.variable)} = "${escHtml(detail.value)}"</div>`;
      case 'subflow': {
        let html = `<div class="story-step story-detail">${indent}  📞 Called subflow: "${escHtml(detail.label)}"</div>`;
        if (detail.input) html += `<div class="story-step story-detail">${indent}    ↳ Input: ${escHtml(detail.input)}</div>`;
        return html;
      }
      case 'actioncall':
        return `<div class="story-step story-detail">${indent}  🎬 Action called: ${escHtml(detail.label)} → result: ${escHtml(detail.result)}</div>`;
      case 'screen_field':
        return `<div class="story-step story-detail">${indent}  🖥 Screen field "${escHtml(detail.label)}" value: ${escHtml(detail.value)}</div>`;
      default:
        return '';
    }
  }

  function getPlainText(parsedInterviews) {
    if (!parsedInterviews || parsedInterviews.length === 0) return '';
    const lines = [];

    for (const interview of parsedInterviews) {
      lines.push('════════════════════════════════════════════');
      lines.push(`📖 Flow Execution Story: "${interview.flowLabel}"`);
      if (interview.timestamp) lines.push(`Ran at: ${interview.timestamp}`);
      lines.push('════════════════════════════════════════════');
      lines.push('');

      for (const step of interview.steps) {
        const line = stepToText(step);
        if (line) lines.push(line);
      }

      lines.push('');
      lines.push('════════════════════════════════════════════');
      const s = interview.stats;
      lines.push(`Total elements executed: ${countElements(interview.steps)}`);
      lines.push(`Subflows called: ${s.subflows}`);
      lines.push(`Records created: ${s.created} | Updated: ${s.updated} | Deleted: ${s.deleted} | Queried: ${s.queried}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function stepToText(step) {
    switch (step.type) {
      case 'start': return `▶ Flow started: ${step.label}`;
      case 'end': return '⏹ Flow finished';
      case 'scheduled': return '📅 Scheduled path triggered';
      case 'bulk_begin': return `  ⚡ Bulk operation started: ${step.label}`;
      case 'bulk_end': return `  ⚡ Bulk operation completed: ${step.label}`;
      case 'subflow_call': return `  📞 Called subflow: "${step.detail.label}"`;
      case 'element': {
        const icon = ELEMENT_ICONS[step.elementType] || '▪';
        const humanLabel = ELEMENT_LABELS[step.elementType] || step.elementType;
        const lines = [`  ${step.stepNum}. ${icon} ${humanLabel} — "${step.elementLabel}"`];
        for (const d of step.details) {
          const dl = detailToText(d, '    ');
          if (dl) lines.push(dl);
        }
        return lines.join('\n');
      }
      default: return '';
    }
  }

  function detailToText(detail, indent) {
    switch (detail.type) {
      case 'rule': {
        let t = `${indent}↳ Condition "${detail.label}" evaluated to: ${detail.result}`;
        if (detail.path) t += `\n${indent}↳ Took path: "${detail.path}"`;
        return t;
      }
      case 'assignment': return `${indent}✏ Set ${detail.variable} = "${detail.value}"`;
      case 'loop': return `${indent}🔁 Loop iteration ${detail.n}: ${detail.variable} = "${detail.value}"`;
      case 'subflow': return `${indent}📞 Called subflow: "${detail.label}"`;
      case 'actioncall': return `${indent}🎬 Action called: ${detail.label} → result: ${detail.result}`;
      case 'screen_field': return `${indent}🖥 Screen field "${detail.label}" value: ${detail.value}`;
      default: return '';
    }
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function initTab(container) {
    container.innerHTML = `
      <div class="debug-story-tab">
        <div class="debug-input-area">
          <label class="debug-label">Paste your Salesforce Flow Debug Log below:</label>
          <textarea id="debugLogInput" class="debug-textarea" placeholder="Paste FLOW_START_INTERVIEW_BEGIN... output here"></textarea>
          <button class="btn btn-primary" id="parseLogBtn">📖 Parse Log</button>
        </div>
        <div id="debugError" class="debug-error" style="display:none"></div>
        <div id="debugStoryOutput" class="debug-story-output" style="display:none">
          <div id="debugStoryContent" class="debug-story-content"></div>
          <div class="debug-export-btns">
            <button class="btn btn-secondary" id="copyStoryBtn">📋 Copy to Clipboard</button>
            <button class="btn btn-secondary" id="downloadStoryBtn">⬇ Download as .txt</button>
          </div>
        </div>
      </div>
    `;

    let lastParsed = null;

    document.getElementById('parseLogBtn').addEventListener('click', () => {
      const raw = document.getElementById('debugLogInput').value.trim();
      const errorEl = document.getElementById('debugError');
      const outputEl = document.getElementById('debugStoryOutput');
      const contentEl = document.getElementById('debugStoryContent');

      errorEl.style.display = 'none';
      outputEl.style.display = 'none';

      if (!raw || !raw.includes('FLOW_')) {
        errorEl.textContent = '⚠️ This doesn\'t look like a Salesforce flow debug log. Paste the full debug output from Flow Builder\'s debug run.';
        errorEl.style.display = '';
        return;
      }

      lastParsed = parseLog(raw);
      if (!lastParsed || lastParsed.length === 0) {
        errorEl.textContent = '⚠️ Could not parse any flow interviews from this log. Make sure you paste the complete debug output.';
        errorEl.style.display = '';
        return;
      }

      contentEl.innerHTML = renderStoryHTML(lastParsed);
      outputEl.style.display = '';
    });

    document.getElementById('copyStoryBtn').addEventListener('click', () => {
      if (!lastParsed) return;
      const text = getPlainText(lastParsed);
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyStoryBtn');
        btn.textContent = '✅ Copied!';
        setTimeout(() => btn.textContent = '📋 Copy to Clipboard', 2000);
      });
    });

    document.getElementById('downloadStoryBtn').addEventListener('click', () => {
      if (!lastParsed) return;
      const text = getPlainText(lastParsed);
      const flowName = (lastParsed[0]?.flowLabel || 'Flow').replace(/\s+/g, '_');
      const date = new Date().toISOString().slice(0, 10);
      const filename = `FlowStory_${flowName}_${date}.txt`;
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  return { initTab, parseLog, renderStoryHTML, getPlainText };
})();
