'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface DesignSelectorProps {
    /** 效果图列表（来自 Vendure 商品素材） */
    images: Array<{
        id: string;
        preview: string;
        source: string;
        name: string;
    }>;
    /** 当前选中的设计名称（文件名） */
    selectedDesign: string | null;
    /** 设计被选中时的回调 */
    onDesignSelect: (designName: string) => void;
}

/**
 * 设计图选择器 (Design Selector)
 * 
 * 展示穿戴甲效果图的轮播组件。
 * - 每张图右下角显示编号（1-N）
 * - 左右滑动浏览
 * - 点击图片 = 选中该设计
 * - 选中状态高亮边框 + 角标
 */
export function DesignSelector({ images, selectedDesign, onDesignSelect }: DesignSelectorProps) {
    const [currentIndex, setCurrentIndex] = useState(0);

    if (!images || images.length === 0) {
        return (
            <div className="aspect-square bg-muted rounded-lg flex items-center justify-center">
                <span className="text-muted-foreground">暂无效果图</span>
            </div>
        );
    }

    const goToPrevious = () => {
        setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
    };

    const goToNext = () => {
        setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
    };

    const handleSelectDesign = (index: number) => {
        const selectedImage = images[index];
        // Use the asset name as the design ID (filename without extension ideally, or just name field from API)
        onDesignSelect(selectedImage.name);
    };

    // Helper to check if current image is selected
    const currentImage = images[currentIndex];
    const isSelected = selectedDesign === currentImage.name;

    return (
        <div className="space-y-4">
            {/* 主图区域 */}
            <div
                className={`relative aspect-square bg-muted rounded-lg overflow-hidden group cursor-pointer transition-all ${isSelected
                    ? 'ring-4 ring-primary ring-offset-2'
                    : 'hover:ring-2 hover:ring-primary/50'
                    }`}
                onClick={() => handleSelectDesign(currentIndex)}
            >
                <Image
                    src={images[currentIndex].source}
                    alt={images[currentIndex].name || `设计图 ${currentIndex + 1}`}
                    fill
                    className="object-cover"
                    sizes="(max-width: 1024px) 100vw, 50vw"
                    priority={currentIndex === 0}
                />

                {/* 选中标记 */}
                {isSelected && (
                    <div className="absolute top-3 left-3 bg-primary text-primary-foreground rounded-full p-1.5">
                        <Check className="h-5 w-5" />
                    </div>
                )}

                {/* 设计名称角标 */}
                <Badge
                    variant="secondary"
                    className="absolute bottom-3 right-3 text-base px-3 py-1 bg-background/90 backdrop-blur-sm"
                >
                    {images[currentIndex].name}
                </Badge>

                {/* 提示文字 */}
                {!selectedDesign && (
                    <div className="absolute top-3 right-3 bg-primary/90 text-primary-foreground text-xs px-2 py-1 rounded">
                        点击选择此设计
                    </div>
                )}

                {/* 左右导航箭头 */}
                {images.length > 1 && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                                e.stopPropagation();
                                goToPrevious();
                            }}
                        >
                            <ChevronLeft className="h-6 w-6" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 hover:bg-background opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                                e.stopPropagation();
                                goToNext();
                            }}
                        >
                            <ChevronRight className="h-6 w-6" />
                        </Button>
                    </>
                )}

                {/* 图片计数 */}
                {images.length > 1 && (
                    <div className="absolute bottom-3 left-3 bg-background/80 px-3 py-1 rounded-full text-sm">
                        {currentIndex + 1} / {images.length}
                    </div>
                )}

                {/* Explicit Select Button */}
                {!isSelected && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
                        <Button
                            size="sm"
                            variant="secondary"
                            className="shadow-lg hover:scale-105 transition-transform"
                            onClick={(e) => {
                                e.stopPropagation();
                                handleSelectDesign(currentIndex);
                            }}
                        >
                            选择此设计 (Select)
                        </Button>
                    </div>
                )}
            </div>

            {/* 缩略图网格 */}
            {images.length > 1 && (
                <div className="grid grid-cols-5 gap-2">
                    {images.map((image, index) => {
                        const isThisSelected = selectedDesign === image.name;
                        return (
                            <button
                                key={image.id}
                                onClick={() => {
                                    setCurrentIndex(index);
                                    handleSelectDesign(index);
                                }}
                                className={`aspect-square relative rounded-lg overflow-hidden border-2 transition-all ${index === currentIndex
                                    ? 'border-primary'
                                    : isThisSelected
                                        ? 'border-primary/50'
                                        : 'border-transparent hover:border-muted-foreground'
                                    }`}
                            >
                                <Image
                                    src={image.preview}
                                    alt={image.name || `设计 ${index + 1}`}
                                    fill
                                    className="object-cover"
                                    sizes="20vw"
                                />
                                {/* 缩略图名称 */}
                                <span className="absolute bottom-0 text-[10px] bg-background/80 w-full text-center truncate px-1">
                                    {image.name}
                                </span>
                                {/* 选中勾 */}
                                {isThisSelected && (
                                    <div className="absolute top-0.5 left-0.5 bg-primary text-primary-foreground rounded-full p-0.5">
                                        <Check className="h-3 w-3" />
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* 已选提示 */}
            {selectedDesign && (
                <p className="text-sm text-primary font-medium">
                    ✓ 已选择设计: {selectedDesign}
                </p>
            )}
        </div>
    );
}
