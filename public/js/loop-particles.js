/**
 * Loop particle animation system.
 * Renders animated particles along the SVG loop path, with stage-aware
 * colouring, burst transitions, and a celebratory sweep effect.
 * @module loop-particles
 */

import { store } from './store.js';

export class LoopParticleSystem {
    constructor() {
        this.pathEl = document.getElementById('loop-path');
        this.container = document.getElementById('loopParticles');
        this.particles = [];
        this.animationId = null;
        this.lastTimestamp = 0;
        this.running = false;
        this.activeStage = null;
        this.totalLength = 0;

        this.stageColors = {
            meet: '#3b82f6',
            analyze: '#f59e0b',
            build: '#10b981',
            verify: '#8b5cf6',
        };

        this.segments = {
            meet:    { start: 0.00, end: 0.25 },
            analyze: { start: 0.25, end: 0.50 },
            build:   { start: 0.50, end: 0.75 },
            verify:  { start: 0.75, end: 1.00 },
        };
    }

    /** Initialise path length and create default particles. */
    init() {
        if (!this.pathEl || !this.container) return;
        this.totalLength = this.pathEl.getTotalLength();
        this._createParticles(14);
    }

    _createParticles(count) {
        for (let i = 0; i < count; i++) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', '#ffffff');
            circle.setAttribute('opacity', '0');
            circle.classList.add('loop-particle');
            this.container.appendChild(circle);

            this.particles.push({
                element: circle,
                offset: (i / count) * this.totalLength,
                speed: 50 + Math.random() * 25,
                baseSpeed: 50 + Math.random() * 25,
                radius: 3 + Math.random() * 2.5,
                opacity: 0.7 + Math.random() * 0.3,
            });
        }
    }

    /** Start the particle animation loop for the given stage. */
    start(activeStage) {
        if (!this.pathEl || this.running) return;
        this.activeStage = activeStage;
        this.running = true;
        this.lastTimestamp = performance.now();

        this.particles.forEach(p => {
            p.element.setAttribute('opacity', String(p.opacity));
            p.element.setAttribute('r', String(p.radius));
        });

        this.animationId = requestAnimationFrame((t) => this._animate(t));
    }

    /** Stop all particle animation. */
    stop() {
        this.running = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.particles.forEach(p => {
            p.element.setAttribute('opacity', '0');
        });
    }

    /** Set the currently active stage; starts/stops animation as needed. */
    setActiveStage(stage) {
        this.activeStage = stage;
        if (stage && !this.running) {
            this.start(stage);
        } else if (!stage) {
            this.stop();
        }
    }

    _getSegmentForOffset(normalizedOffset) {
        for (const [name, seg] of Object.entries(this.segments)) {
            if (normalizedOffset >= seg.start && normalizedOffset < seg.end) {
                return name;
            }
        }
        return 'meet';
    }

    _getColorForOffset(normalizedOffset) {
        const segment = this._getSegmentForOffset(normalizedOffset);
        return this.stageColors[segment] || '#ffffff';
    }

    _isInActiveSegment(normalizedOffset) {
        if (!this.activeStage) return false;
        const seg = this.segments[this.activeStage];
        return normalizedOffset >= seg.start && normalizedOffset < seg.end;
    }

    _animate(timestamp) {
        if (!this.running) return;

        const delta = Math.min(timestamp - this.lastTimestamp, 50);
        this.lastTimestamp = timestamp;

        this.particles.forEach(p => {
            const normalizedOffset = p.offset / this.totalLength;
            const inActive = this._isInActiveSegment(normalizedOffset);

            const currentSpeed = inActive ? p.baseSpeed * 2 : p.baseSpeed;
            p.offset = (p.offset + currentSpeed * delta * 0.001) % this.totalLength;

            const point = this.pathEl.getPointAtLength(p.offset);
            p.element.setAttribute('cx', point.x);
            p.element.setAttribute('cy', point.y);

            const color = this._getColorForOffset(p.offset / this.totalLength);
            p.element.setAttribute('fill', color);

            const size = inActive ? p.radius * 1.8 : p.radius;
            p.element.setAttribute('r', String(size));

            const opacity = inActive ? Math.min(p.opacity * 1.4, 1) : p.opacity * 0.6;
            p.element.setAttribute('opacity', String(opacity));
        });

        this.animationId = requestAnimationFrame((t) => this._animate(t));
    }

    /** Fire burst particles from one stage to the next. */
    triggerBurst(fromStage, toStage) {
        if (!this.pathEl || !this.container) return;

        const fromSeg = this.segments[fromStage];
        const toSeg = this.segments[toStage];
        if (!fromSeg || !toSeg) return;

        const startOffset = fromSeg.end * this.totalLength;
        const burstParticles = [];

        for (let i = 0; i < 4; i++) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            const r = i === 0 ? 7 : 4;
            circle.setAttribute('r', String(r));
            circle.setAttribute('fill', this.stageColors[fromStage] || '#fff');
            circle.setAttribute('opacity', i === 0 ? '1' : '0.7');
            circle.classList.add('loop-particle', 'loop-particle--burst');
            this.container.appendChild(circle);
            burstParticles.push({
                element: circle,
                offset: startOffset + (i * -8),
                speed: 120 + i * 15,
                targetOffset: toSeg.start * this.totalLength,
            });
        }

        let burstStart = performance.now();
        const animateBurst = (timestamp) => {
            const elapsed = timestamp - burstStart;
            let allArrived = true;

            burstParticles.forEach(bp => {
                bp.offset = (bp.offset + bp.speed * 16 * 0.001) % this.totalLength;
                const point = this.pathEl.getPointAtLength(bp.offset);
                bp.element.setAttribute('cx', point.x);
                bp.element.setAttribute('cy', point.y);

                const fadeProgress = Math.min(elapsed / 800, 1);
                bp.element.setAttribute('opacity', String(Math.max(1 - fadeProgress, 0)));

                if (elapsed < 800) allArrived = false;
            });

            if (!allArrived) {
                requestAnimationFrame(animateBurst);
            } else {
                burstParticles.forEach(bp => bp.element.remove());
                this._triggerCrossoverFlash();
            }
        };
        requestAnimationFrame(animateBurst);

        if (toStage) this.setActiveStage(toStage);
    }

    _triggerCrossoverFlash() {
        const loopContainer = document.querySelector('.loop-container');
        if (!loopContainer) return;

        const flash = document.createElement('div');
        flash.className = 'loop-crossover-burst';
        loopContainer.appendChild(flash);

        flash.addEventListener('animationend', () => flash.remove());
    }

    /** Run a full celebratory sweep particle around the loop. */
    celebratoryLoop() {
        if (!this.pathEl) return;
        const sweep = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        sweep.setAttribute('r', '8');
        sweep.setAttribute('fill', '#ffffff');
        sweep.setAttribute('opacity', '1');
        sweep.classList.add('loop-particle', 'loop-particle--celebration');
        this.container.appendChild(sweep);

        let offset = 0;
        const totalLen = this.totalLength;
        const speed = 200;

        const animateSweep = (timestamp) => {
            offset += speed * 16 * 0.001;
            if (offset >= totalLen) {
                sweep.remove();
                return;
            }
            const point = this.pathEl.getPointAtLength(offset);
            sweep.setAttribute('cx', point.x);
            sweep.setAttribute('cy', point.y);
            sweep.setAttribute('fill', this._getColorForOffset(offset / totalLen));
            const fadeOut = Math.max(1 - (offset / totalLen) * 0.3, 0.5);
            sweep.setAttribute('opacity', String(fadeOut));
            requestAnimationFrame(animateSweep);
        };
        requestAnimationFrame(animateSweep);
    }
}
