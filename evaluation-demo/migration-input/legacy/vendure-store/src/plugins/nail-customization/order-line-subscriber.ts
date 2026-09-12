import { EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from 'typeorm';
import { OrderLine } from '@vendure/core';
import { matchNailSize } from './nail-size-data';

@EventSubscriber()
export class OrderLineSubscriber implements EntitySubscriberInterface<OrderLine> {
    listenTo() {
        return OrderLine;
    }

    async beforeInsert(event: InsertEvent<OrderLine>) {
        await this.handleNailMatching(event.entity);
    }

    async beforeUpdate(event: UpdateEvent<OrderLine>) {
        if (event.entity) {
            await this.handleNailMatching(event.entity as OrderLine);
        }
    }

    private async handleNailMatching(entity: OrderLine) {
        const customFields = (entity as any).customFields;
        if (!customFields) return;

        const nailSizes = customFields.nailSizes;
        const nailShape = customFields.nailShape;

        if (nailSizes && nailShape) {
            // nailSizes format: leftThumb:1,leftIndex:8...
            const pairs = nailSizes.split(',');
            const matchedModels: string[] = [];

            for (const pair of pairs) {
                const [finger, sizeStr] = pair.split(':');
                if (sizeStr) {
                    const size = parseFloat(sizeStr);
                    const match = matchNailSize(size, nailShape);
                    if (match) {
                        matchedModels.push(match.number);
                    } else {
                        matchedModels.push('?');
                    }
                }
            }

            if (matchedModels.length > 0) {
                customFields.matchedNailModel = matchedModels.join(',');
                console.log(`[NailMatching] Shape: ${nailShape}, Input: ${nailSizes}, Matched: ${customFields.matchedNailModel}`);
                // Debug: dump the sizes used
                const { NAIL_SHAPES } = require('./nail-size-data');
                const shape = NAIL_SHAPES.find((s: any) => s.code === nailShape);
                if (shape) {
                    console.log(`[NailMatching-Debug] Sizes for ${nailShape}: ${shape.sizes.map((s: any) => `${s.number}:${s.arcLength}`).join(', ')}`);
                }
            }
        }
    }
}
