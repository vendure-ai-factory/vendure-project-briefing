'use client';

import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

interface CitySelectProps {
    cities: string[];
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    onManualEntry?: () => void;
}

export function CitySelect({ cities, value, onValueChange, disabled, onManualEntry }: CitySelectProps) {
    const [open, setOpen] = React.useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between"
                    disabled={disabled}
                >
                    {value || 'Select city...'}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-full p-0" align="start">
                <Command>
                    <CommandInput placeholder="Search city..." />
                    <CommandList>
                        <CommandEmpty>
                            <div className="p-2">
                                <p className="text-sm text-muted-foreground mb-2">City not found.</p>
                                <Button variant="secondary" size="sm" onClick={() => {
                                    onManualEntry?.();
                                    setOpen(false);
                                }} className="w-full">
                                    Enter manually
                                </Button>
                            </div>
                        </CommandEmpty>
                        <CommandGroup heading="Suggestions">
                            {cities.map((city) => (
                                <CommandItem
                                    key={city}
                                    value={city}
                                    onSelect={(currentValue) => {
                                        // currentValue is lowercased by default in cmdk, but we usually want to keep the display casing
                                        // However, for city names, we can just use the 'city' prop directly if we match it
                                        // Or trust the value. Let's use the 'city' (original case)
                                        onValueChange(city);
                                        setOpen(false);
                                    }}
                                >
                                    <Check
                                        className={cn(
                                            'mr-2 h-4 w-4',
                                            value === city ? 'opacity-100' : 'opacity-0'
                                        )}
                                    />
                                    {city}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup heading="Options">
                            <CommandItem
                                value="other_manual_entry"
                                onSelect={() => {
                                    onManualEntry?.();
                                    setOpen(false);
                                }}
                                className="font-medium text-primary cursor-pointer"
                            >
                                Other / Enter manually...
                            </CommandItem>
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
