/**
 * Happy Hour Settings Component
 * 
 * Manage time-based pricing promotions.
 */

import { useState } from "react";
import { useHappyHour, HappyHour, DiscountType } from "@/hooks/pos/useHappyHour";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Clock, Plus, MoreVertical, Trash2, Edit, Percent, DollarSign } from "lucide-react";

interface HappyHourSettingsProps {
  branchId?: string;
}

const DAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export function HappyHourSettings({ branchId }: HappyHourSettingsProps) {
  const {
    happyHours,
    isLoading,
    createHappyHour,
    updateHappyHour,
    deleteHappyHour,
    isHappyHourActive,
    formatTime,
    getDayNames,
  } = useHappyHour(branchId);
  
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingHappyHour, setEditingHappyHour] = useState<HappyHour | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    discount_type: "percentage" as DiscountType,
    discount_value: 20,
    start_time: "16:00",
    end_time: "19:00",
    days_of_week: [1, 2, 3, 4, 5] as number[],
  });

  const resetForm = () => {
    setFormData({
      name: "",
      description: "",
      discount_type: "percentage",
      discount_value: 20,
      start_time: "16:00",
      end_time: "19:00",
      days_of_week: [1, 2, 3, 4, 5],
    });
    setEditingHappyHour(null);
  };

  const handleOpenDialog = (happyHour?: HappyHour) => {
    if (happyHour) {
      setEditingHappyHour(happyHour);
      setFormData({
        name: happyHour.name,
        description: happyHour.description || "",
        discount_type: happyHour.discount_type,
        discount_value: happyHour.discount_value,
        start_time: happyHour.start_time.slice(0, 5),
        end_time: happyHour.end_time.slice(0, 5),
        days_of_week: happyHour.days_of_week,
      });
    } else {
      resetForm();
    }
    setIsDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) return;
    
    const data = {
      name: formData.name,
      description: formData.description || undefined,
      discount_type: formData.discount_type,
      discount_value: formData.discount_value,
      start_time: formData.start_time + ":00",
      end_time: formData.end_time + ":00",
      days_of_week: formData.days_of_week,
      branch_id: branchId,
    };
    
    if (editingHappyHour) {
      await updateHappyHour.mutateAsync({ id: editingHappyHour.id, ...data });
    } else {
      await createHappyHour.mutateAsync(data);
    }
    
    setIsDialogOpen(false);
    resetForm();
  };

  const toggleDay = (day: number) => {
    setFormData(prev => ({
      ...prev,
      days_of_week: prev.days_of_week.includes(day)
        ? prev.days_of_week.filter(d => d !== day)
        : [...prev.days_of_week, day].sort(),
    }));
  };

  const getDiscountLabel = (type: DiscountType, value: number) => {
    switch (type) {
      case "percentage":
        return `${value}% off`;
      case "fixed_amount":
        return `$${value} off`;
      case "fixed_price":
        return `$${value} fixed`;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Happy Hour
          </CardTitle>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => handleOpenDialog()}>
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingHappyHour ? "Edit Happy Hour" : "Create Happy Hour"}
                </DialogTitle>
              </DialogHeader>
              
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Weekday Happy Hour"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="e.g., 20% off all drinks"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Discount Type</Label>
                    <Select
                      value={formData.discount_type}
                      onValueChange={(v) => setFormData({ ...formData, discount_type: v as DiscountType })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">
                          <div className="flex items-center gap-2">
                            <Percent className="h-4 w-4" />
                            Percentage
                          </div>
                        </SelectItem>
                        <SelectItem value="fixed_amount">
                          <div className="flex items-center gap-2">
                            <DollarSign className="h-4 w-4" />
                            Fixed Amount Off
                          </div>
                        </SelectItem>
                        <SelectItem value="fixed_price">
                          <div className="flex items-center gap-2">
                            <DollarSign className="h-4 w-4" />
                            Fixed Price
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Value</Label>
                    <Input
                      type="number"
                      min={0}
                      value={formData.discount_value}
                      onChange={(e) => setFormData({ ...formData, discount_value: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Start Time</Label>
                    <Input
                      type="time"
                      value={formData.start_time}
                      onChange={(e) => setFormData({ ...formData, start_time: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>End Time</Label>
                    <Input
                      type="time"
                      value={formData.end_time}
                      onChange={(e) => setFormData({ ...formData, end_time: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Days of Week</Label>
                  <div className="flex gap-2 flex-wrap">
                    {DAYS.map((day) => (
                      <div
                        key={day.value}
                        onClick={() => toggleDay(day.value)}
                        className={`px-3 py-1.5 rounded-md text-sm cursor-pointer transition-colors ${
                          formData.days_of_week.includes(day.value)
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary hover:bg-secondary/80"
                        }`}
                      >
                        {day.label}
                      </div>
                    ))}
                  </div>
                </div>

                <Button
                  className="w-full"
                  onClick={handleSave}
                  disabled={!formData.name.trim() || createHappyHour.isPending || updateHappyHour.isPending}
                >
                  {editingHappyHour ? "Update" : "Create"} Happy Hour
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : happyHours.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No happy hours configured</p>
            <p className="text-sm">Create one to offer time-based discounts</p>
          </div>
        ) : (
          <div className="space-y-3">
            {happyHours.map((hh) => (
              <div
                key={hh.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-card"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{hh.name}</span>
                    {isHappyHourActive(hh) && (
                      <Badge className="bg-green-500">Active Now</Badge>
                    )}
                    {!hh.is_active && (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                    <span>{formatTime(hh.start_time)} - {formatTime(hh.end_time)}</span>
                    <span>•</span>
                    <span>{getDayNames(hh.days_of_week)}</span>
                    <span>•</span>
                    <span className="text-primary font-medium">
                      {getDiscountLabel(hh.discount_type, hh.discount_value)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    checked={hh.is_active}
                    onCheckedChange={(checked) => updateHappyHour.mutate({ id: hh.id, is_active: checked })}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleOpenDialog(hh)}>
                        <Edit className="h-4 w-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => deleteHappyHour.mutate(hh.id)}
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
