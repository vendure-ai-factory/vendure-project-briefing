'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { DesignSelector } from './design-selector';
import { ProductInfo } from './product-info';
import { fetchNailProfiles, fetchAllNailShapes, fetchMatchNailSize, NailProfile, NailShapeInfo } from '@/lib/vendure/nail-api';

interface ProductViewProps {
    product: any;
    searchParams: any;
    initialProfiles?: NailProfile[];
    country?: string;
}

export function ProductView({ product, searchParams, initialProfiles = [], country }: ProductViewProps) {
    const router = useRouter();

    // Customization State
    const [selectedDesign, setSelectedDesign] = useState<string | null>(null);
    const [selectedShape, setSelectedShape] = useState<string | null>(null);
    const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
    const [matchResults, setMatchResults] = useState<any[]>([]);

    // ─── 解析设计模板索引表 ──────────────────────────────────────────────────
    const designTemplate = useMemo(() => {
        try {
            const templateJson = product.customFields?.designTemplate;
            return templateJson ? JSON.parse(templateJson) : null;
        } catch (e) {
            console.error('Failed to parse designTemplate:', e);
            return null;
        }
    }, [product.customFields?.designTemplate]);

    const displayImages = useMemo(() => {
        // 如果有新版的 indexTable，优先使用
        if (designTemplate?.indexTable && designTemplate.indexTable.length > 0) {
            const baseUrl = process.env.NEXT_PUBLIC_VENDURE_API_URL?.replace('/shop-api', '') || '';
            const fixUrl = (url: string) => url.startsWith('http') ? url : `${baseUrl}/assets/${url}`;
            
            return designTemplate.indexTable.map((item: any) => ({
                id: String(item.index),
                preview: fixUrl(item.previewUrl),
                source: fixUrl(item.previewUrl),
                name: item.index === 0 ? 'Default' : `Design ${item.index}`,
                isMain: item.index === 0,
            }));
        }
        
        // 否则回退到旧版的 assets 过滤逻辑
        return (product.assets || [])
            .filter((a: any) => a.id !== product.featuredAsset?.id)
            .map((a: any) => ({
                ...a,
                isMain: false
            }));
    }, [product.assets, product.featuredAsset?.id, designTemplate]);

    // Data Loading State
    const [profiles, setProfiles] = useState<NailProfile[]>(initialProfiles);
    const [shapes, setShapes] = useState<NailShapeInfo[]>([]);
    const [loadingProfiles, setLoadingProfiles] = useState(true);

    // Initial Data Fetch
    useEffect(() => {
        async function initData() {
            try {
                // Ensure auth profiles propagated before removing loading spinner
                setProfiles(initialProfiles);

                const s = await fetchAllNailShapes();
                setShapes(s);

                // If there's only one profile, select it by default
                if (initialProfiles.length === 1) {
                    setSelectedProfileId(initialProfiles[0].id);
                }
            } catch (error) {
                console.error('Failed to fetch nail customization data:', error);
            } finally {
                setLoadingProfiles(false);
            }
        }
        initData();
    }, [initialProfiles]);

    // Matching Logic: When profile or shape changes
    const runMatching = useCallback(async (profileId: string | null, shapeCode: string | null) => {
        if (!profileId || !shapeCode) {
            setMatchResults([]);
            return;
        }

        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return;

        const fingers = Object.keys(profile.fingerSizes);
        const results = await Promise.all(
            fingers.map(async (finger) => {
                const size = profile.fingerSizes[finger];
                if (!size) return null;
                const match = await fetchMatchNailSize(size, shapeCode);
                return match ? { finger, matchedModel: match.number, arcLength: size, exact: match.exact } : null;
            })
        );

        setMatchResults(results.filter(Boolean));
    }, [profiles]);

    useEffect(() => {
        runMatching(selectedProfileId, selectedShape);
    }, [selectedProfileId, selectedShape, runMatching]);

    const handleShapeChange = (code: string) => {
        setSelectedShape(code);
    };

    const handleProfileChange = (id: string) => {
        setSelectedProfileId(id);
    };

    const handleManageProfiles = () => {
        router.push('/account/nail-sizes');
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
            {/* Left Column: Custom Design Selector */}
            <div className="lg:sticky lg:top-20 lg:self-start">
                <DesignSelector
                    images={displayImages}
                    selectedDesign={selectedDesign}
                    onDesignSelect={setSelectedDesign}
                />
            </div>

            {/* Right Column: Enhanced Product Info */}
            <div>
                <ProductInfo
                    product={product}
                    searchParams={searchParams}
                    selectedDesign={selectedDesign}
                    selectedShape={selectedShape}
                    selectedProfileId={selectedProfileId}
                    matchResults={matchResults}
                    shapes={shapes.map(s => ({ code: s.code, name: s.nameZh }))}
                    profiles={profiles}
                    loadingProfiles={loadingProfiles}
                    onShapeChange={handleShapeChange}
                    onProfileChange={handleProfileChange}
                    onManageProfiles={handleManageProfiles}
                    countryCode={country}
                />
            </div>
        </div>
    );
}
