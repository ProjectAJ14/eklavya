/* Archer Cloak — shared, local-only artwork for the site and npm dashboard. */
(function (root) {
  'use strict';
  const expressions = Object.freeze({
    neutral: 'Calm and attentive', happy: 'Happy', excited: 'Excited', celebrate: 'Celebrating',
    curious: 'Curious', thinking: 'Thinking', focused: 'Focused', wink: 'Offering a tip',
    surprised: 'Surprised', confused: 'Seeking clarity', worried: 'Concerned', sad: 'Sad', sleepy: 'Resting'
  });
  const states = Object.freeze({ idle: 'sleepy', info: 'neutral', success: 'happy', complete: 'celebrate',
    milestone: 'celebrate', empty: 'curious', notFound: 'curious', loading: 'excited',
    review: 'focused', tip: 'wink', new: 'surprised', validation: 'confused', warning: 'worried', error: 'sad' });
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const escape = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function expressionForState(state) { return own(states, state) ? states[state] : 'neutral'; }
  function dimension(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(512, Math.max(16, n)) : 64; }
  function face(expression) {
    const eyes = '<rect x="64" y="64" width="10" height="19" rx="5"/><rect x="110" y="64" width="10" height="19" rx="5"/>';
    const smile = '<path d="M83 88q9 10 18 0"/>';
    const closed = '<path d="M64 74q5-7 10 0m36 0q5-7 10 0"/>';
    const brows = { focused: 'M62 57l14 4m32 0 14-4', thinking: 'M62 58h14m33-2 13 3',
      worried:'M62 59l14-6m32 0 14 6', sad:'M62 60l14-5m32 0 14 5',
      confused:'M62 58l14-5m32 4h14', curious:'M62 59h14m32-6 14 5' };
    const faces = {
      neutral: eyes + '<path d="M84 89q8 6 16 0"/>', happy: closed + smile,
      celebrate: closed + '<path d="M82 87q10 22 20 0Z" fill="var(--mascot-ink)"/><path d="M87 98h10" stroke="var(--mascot-coral)"/>',
      excited: eyes + '<path d="M81 87q11 22 22 0Z" fill="var(--mascot-ink)"/><path d="M87 97q5-3 10 0" stroke="var(--mascot-coral)"/>',
      curious: eyes + '<path d="M86 91q6-4 12 0"/>', thinking: eyes + '<path d="M86 91h10"/>',
      focused: eyes + '<path d="M85 91h14"/>', wink: '<rect x="64" y="64" width="10" height="19" rx="5"/><path d="M110 74q5-7 10 0"/>' + smile,
      surprised: eyes + '<ellipse cx="92" cy="92" rx="5" ry="7" fill="var(--mascot-ink)"/>',
      confused: eyes + '<path d="M83 93q5-7 10-2t9-2"/>', worried: eyes + '<path d="M83 95q9-9 18 0"/>',
      sad: eyes + '<path d="M83 96q9-9 18 0"/>', sleepy: '<path d="M64 75q5 5 10 0m36 0q5 5 10 0m-30 16h10"/>'
    };
    return `<g class="ek-mascot__face" fill="var(--mascot-ink)" stroke="var(--mascot-ink)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${faces[expression]}${brows[expression] ? `<path d="${brows[expression]}" fill="none"/>` : ''}</g>`;
  }
  function svg({ expression = 'neutral', state, variant = 'body', size = 64, label = null } = {}) {
    expression = state ? expressionForState(state) : own(expressions, expression) ? expression : 'neutral';
    variant = ['body','face','loading'].includes(variant) ? variant : 'body';
    const loading = variant === 'loading';
    const px = dimension(size);
    const head = `<g class="ek-mascot__head">
        <path d="M46 43h18V29h19V18h23v12h20v14h17v19h8v29h-8v16q0 12-16 15H62q-18-3-18-17V91h-9V63h11Z" fill="var(--mascot-coral)" stroke="var(--mascot-coral-dark)" stroke-width="2" stroke-linejoin="round"/>
        <path d="M48 45h18V32h18V21h19" fill="none" stroke="var(--mascot-highlight)" stroke-width="3" stroke-linejoin="round"/>
        ${face(expression)}
      </g>`;
    const body = `<g class="ek-mascot__character">
      <ellipse cx="94" cy="185" rx="49" ry="5" fill="var(--mascot-shadow)"/>
      <path d="M51 124Q29 137 34 168l23-8 17-27m59-9q26 8 21 39l-24-7-17-22" fill="var(--mascot-cloak-dark)"/>
      <path d="M65 157v23q0 8 16 6l4-28m21 0 1 23q2 8 17 4v-29" fill="var(--mascot-coral)"/>
      <path d="M58 122q35-16 72 0l8 46q-19 9-42 1-23 7-43-1Z" fill="var(--mascot-cloak)"/>
      <path d="M96 127v40m-31-22q29 9 64 0" fill="none" stroke="var(--mascot-cloak-dark)" stroke-width="3"/>
      <path d="M52 109q42-22 86 0l-9 29-32-14-32 14Z" fill="var(--mascot-cloak)" stroke="var(--mascot-cloak-dark)" stroke-width="3" stroke-linejoin="round"/>
      <path d="M57 114l37 10m42-10-39 10" fill="none" stroke="var(--mascot-thread)" stroke-width="2"/>
      <path d="M54 148h80v11H54Z" fill="var(--mascot-ink)"/>
      <rect x="87" y="146" width="17" height="15" rx="3" fill="var(--mascot-metal)"/><rect x="92" y="150" width="7" height="7" rx="1" fill="var(--mascot-ink)"/>
      ${head}
      <circle cx="96" cy="125" r="7" fill="var(--mascot-metal)"/><circle cx="94" cy="123" r="2" fill="var(--mascot-thread)"/>
      <g class="ek-mascot__bow" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M157 78q36 47 0 94" stroke="var(--mascot-wood-dark)" stroke-width="8"/>
        <path d="M158 78q32 47 0 94" stroke="var(--mascot-wood)" stroke-width="4"/>
        <path class="ek-mascot__string" d="M157 78l-88 50 88 44" stroke="var(--mascot-string)" stroke-width="1.8"/>
      </g>
      <path d="M130 127l16-8q10-1 13 5 2 8-6 11l-15 4" fill="var(--mascot-cloak)"/>
      <rect x="147" y="117" width="15" height="18" rx="7" fill="var(--mascot-coral)"/>
      <g class="ek-mascot__arrow" stroke-linecap="round" stroke-linejoin="round">
        <path d="M69 128h114" stroke="var(--mascot-wood-dark)" stroke-width="3"/>
        <path d="M179 120l13 8-13 8Z" fill="var(--mascot-thread)" stroke="var(--mascot-wood)" stroke-width="1.5"/>
        <path d="M71 128l-9-9 10 1 8 8-8 8-10 1Z" fill="var(--mascot-thread)"/>
      </g>
      <path d="M58 128q-11-6-14 5-2 9 8 13l17-8" fill="var(--mascot-cloak)"/>
      <rect x="62" y="121" width="18" height="16" rx="7" fill="var(--mascot-coral)"/>
    </g>`;
    const accents = expression === 'celebrate' ? '<g fill="var(--mascot-thread)"><path d="m20 47 3-7 3 7 7 3-7 3-3 7-3-7-7-3Z"/><path d="m166 31 2-5 2 5 5 2-5 2-2 5-2-5-5-2Z"/></g>' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${variant === 'face' ? '30 12 126 128' : '0 0 210 200'}" width="${px}" height="${px}" class="ek-mascot${loading ? ' ek-mascot--loading' : ''}" data-expression="${expression}" data-variant="${variant}" ${label == null ? 'aria-hidden="true"' : 'role="img"'}>${label == null ? '' : `<title>${escape(label)}</title>`}${accents}${variant === 'face' ? `<path d="M48 109q44-19 88 0l-8 30-33-15-31 15Z" fill="var(--mascot-cloak)"/>${head}<circle cx="95" cy="126" r="6" fill="var(--mascot-metal)"/>` : body}${loading ? '<circle class="ek-mascot__ripple" cx="196" cy="128" r="10" fill="none" stroke="var(--mascot-thread)" stroke-width="2"/>' : ''}</svg>`;
  }
  root.EklavyaMascot = Object.freeze({ expressions, states, expressionForState, svg });
  if (root.customElements && !root.customElements.get('eklavya-mascot')) {
    class Mascot extends HTMLElement {
      static get observedAttributes() { return ['state','expression','size','variant','label']; }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }
      render() {
        // Decorative by default: the adjoining text owns the status message.
        this.innerHTML = svg({ state: this.getAttribute('state'), expression: this.getAttribute('expression') || 'neutral',
          variant: this.getAttribute('variant') || 'body', size: this.getAttribute('size') || 64, label: this.getAttribute('label') });
      }
    }
    root.customElements.define('eklavya-mascot', Mascot);
  }
})(globalThis);
