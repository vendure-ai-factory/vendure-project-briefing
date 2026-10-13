/**
 * Lifecycle Trace System - Tracking Manager
 * 
 * A lightweight utility to capture logic chain snapshots and data mutations.
 */

export interface TraceCheckpoint {
    timestamp: string;
    node: string;
    action: string;
    metadata: Record<string, any>;
}

class TrackingManager {
    private static instance: TrackingManager;
    private enabled: boolean = process.env.NEXT_PUBLIC_DEBUG_TRACE === 'true';
    private currentTraceId: string | null = null;
    private checkpoints: TraceCheckpoint[] = [];

    private constructor() {}

    public static getInstance(): TrackingManager {
        if (!TrackingManager.instance) {
            TrackingManager.instance = new TrackingManager();
        }
        return TrackingManager.instance;
    }

    public startTrace(traceId?: string): string {
        // Use provided ID or generate a static-ish one that won't trigger Next.js dynamic check errors
        this.currentTraceId = traceId || `tr-${this.enabled ? Date.now() : 'static'}-${Math.random().toString(36).substr(2, 9)}`;
        this.checkpoints = [];
        this.checkpoint('TRACE_START', 'Initialization', { traceId: this.currentTraceId });
        return this.currentTraceId;
    }

    public checkpoint(node: string, action: string, metadata: Record<string, any> = {}) {
        if (!this.enabled && !this.currentTraceId) return;

        const cp: TraceCheckpoint = {
            timestamp: new Date().toISOString(),
            node,
            action,
            metadata,
        };

        this.checkpoints.push(cp);
        
        // Always log to console in debug mode
        if (this.enabled) {
            console.log(`[LTS-TRACE] [${cp.node}] ${cp.action}`, metadata);
        }
    }

    public getReport() {
        return {
            traceId: this.currentTraceId,
            history: this.checkpoints,
        };
    }

    public clear() {
        this.currentTraceId = null;
        this.checkpoints = [];
    }
}

export const lts = TrackingManager.getInstance();
