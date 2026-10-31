/**
 * @fileoverview Manages static mobile layout for WebUI.
 * Provides single-column vertical layout for mobile devices with predefined component order.
 */

import { createComponentElement } from './WebUIComponentRegistry.js';

export class WebUIMobileLayoutManager {
  private container: HTMLElement | null = null;
  // State and progress first, then the camera, the heaters and the controls.
  private readonly componentOrder = [
    'printer-state',
    'job-progress',
    'camera',
    'creator5-temperature',
    'temp-control',
    'controls',
    'job-details',
    'gcode-viewer',
    'ifs-station',
    'light-timer',
    'spoolman-tracker',
    'model-preview',
    'filtration-tvoc',
  ];

  constructor(private readonly containerSelector: string) {}

  public initialize(): void {
    const element = document.querySelector<HTMLElement>(this.containerSelector);
    if (!element) {
      throw new Error(`Mobile layout container not found: ${this.containerSelector}`);
    }
    this.container = element;
  }

  public load(visibleComponents: string[]): void {
    const container = this.container;
    if (!container) {
      throw new Error('Mobile layout not initialized');
    }

    container.innerHTML = '';

    this.componentOrder.forEach((componentId) => {
      if (visibleComponents.includes(componentId)) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('mobile-panel-container');
        wrapper.dataset.componentId = componentId;
        wrapper.appendChild(createComponentElement(componentId));
        container.appendChild(wrapper);
      }
    });
  }

  public clear(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  public showComponent(componentId: string): void {
    const element = this.getComponentElement(componentId);
    if (element) {
      element.classList.remove('hidden');
    }
  }

  public hideComponent(componentId: string): void {
    const element = this.getComponentElement(componentId);
    if (element) {
      element.classList.add('hidden');
    }
  }

  private getComponentElement(componentId: string): HTMLElement | null {
    if (!this.container) return null;
    return this.container.querySelector<HTMLElement>(`[data-component-id="${componentId}"]`);
  }
}
