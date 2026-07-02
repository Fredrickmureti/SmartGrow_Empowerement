/**
 * Restaurant Settings Card
 * 
 * Settings for POS restaurant mode: floors, tables, kitchen display.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useFloorPlan, CreateFloorInput, CreateTableInput } from "@/hooks/pos/useFloorPlan";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  LayoutGrid, 
  Plus, 
  Trash2, 
  Edit,
  ChefHat,
  Calendar,
  Utensils,
  Loader2
} from "lucide-react";
import { toast } from "sonner";

export function RestaurantSettingsCard() {
  const { 
    floors, 
    isLoadingFloors, 
    createFloor, 
    deleteFloor,
    createTable,
    useFloorTables 
  } = useFloorPlan();
  
  const { restaurantSettings, updateRestaurantSettings } = usePOSSettings();

  const [showCreateFloor, setShowCreateFloor] = useState(false);
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [newFloorName, setNewFloorName] = useState("");
  const [newTable, setNewTable] = useState<{
    table_number: string;
    seats: number;
    shape: "square" | "round" | "rectangle";
  }>({
    table_number: "",
    seats: 4,
    shape: "square",
  });

  const { data: tables = [] } = useFloorTables(selectedFloorId);
  
  // Fetch table counts for ALL floors so we can display them correctly
  const { data: allTableCounts = {} } = useQuery({
    queryKey: ["pos-all-floor-table-counts", floors.map(f => f.id).join(",")],
    queryFn: async () => {
      if (floors.length === 0) return {};
      const { data, error } = await supabase
        .from("pos_tables")
        .select("floor_id")
        .in("floor_id", floors.map(f => f.id));
      if (error) throw error;
      const counts: Record<string, number> = {};
      (data || []).forEach((t: any) => {
        counts[t.floor_id] = (counts[t.floor_id] || 0) + 1;
      });
      return counts;
    },
    enabled: floors.length > 0,
  });

  const handleToggleSetting = (key: keyof typeof restaurantSettings, value: boolean) => {
    updateRestaurantSettings.mutate({ [key]: value });
  };

  const handleCreateFloor = async () => {
    if (!newFloorName.trim()) {
      toast.error("Please enter a floor name");
      return;
    }
    
    await createFloor.mutateAsync({ name: newFloorName });
    setNewFloorName("");
    setShowCreateFloor(false);
  };

  const handleCreateTable = async () => {
    if (!selectedFloorId || !newTable.table_number.trim()) {
      toast.error("Please select a floor and enter a table number");
      return;
    }
    
    await createTable.mutateAsync({
      floor_id: selectedFloorId,
      table_number: newTable.table_number,
      seats: newTable.seats,
      shape: newTable.shape,
    });
    setNewTable({ table_number: "", seats: 4, shape: "square" });
    setShowCreateTable(false);
  };

  return (
    <div className="space-y-6">
      {/* Restaurant Mode Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Utensils className="h-5 w-5" />
            Restaurant Mode
          </CardTitle>
          <CardDescription>
            Enable floor plans, table management, and kitchen display for restaurant operations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Restaurant Mode</Label>
              <p className="text-sm text-muted-foreground">Show floor plan before terminal</p>
            </div>
            <Switch 
              checked={restaurantSettings.restaurant_mode_enabled}
              onCheckedChange={(checked) => handleToggleSetting("restaurant_mode_enabled", checked)}
              disabled={updateRestaurantSettings.isPending}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>Kitchen Display System</Label>
              <p className="text-sm text-muted-foreground">Show orders on kitchen screens</p>
            </div>
            <Switch 
              checked={restaurantSettings.kitchen_display_enabled}
              onCheckedChange={(checked) => handleToggleSetting("kitchen_display_enabled", checked)}
              disabled={updateRestaurantSettings.isPending}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>Table Bookings</Label>
              <p className="text-sm text-muted-foreground">Enable reservations</p>
            </div>
            <Switch 
              checked={restaurantSettings.table_bookings_enabled}
              onCheckedChange={(checked) => handleToggleSetting("table_bookings_enabled", checked)}
              disabled={updateRestaurantSettings.isPending}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <Label>Course Management</Label>
              <p className="text-sm text-muted-foreground">Fire courses to kitchen separately</p>
            </div>
            <Switch 
              checked={restaurantSettings.course_management_enabled}
              onCheckedChange={(checked) => handleToggleSetting("course_management_enabled", checked)}
              disabled={updateRestaurantSettings.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {/* Floor Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <LayoutGrid className="h-5 w-5" />
                Floor Plans
              </CardTitle>
              <CardDescription>Manage restaurant floors and table layouts</CardDescription>
            </div>
            <Dialog open={showCreateFloor} onOpenChange={setShowCreateFloor}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Floor
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Floor</DialogTitle>
                  <DialogDescription>Add a new floor to your restaurant layout.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Floor Name</Label>
                    <Input
                      placeholder="e.g., Main Floor, Patio, Terrace"
                      value={newFloorName}
                      onChange={(e) => setNewFloorName(e.target.value)}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowCreateFloor(false)}>Cancel</Button>
                  <Button onClick={handleCreateFloor} disabled={createFloor.isPending}>
                    {createFloor.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Create Floor
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {floors.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <LayoutGrid className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No floors configured</p>
              <Button variant="link" onClick={() => setShowCreateFloor(true)}>
                Create your first floor
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {floors.map(floor => (
                <div key={floor.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-8 h-8 rounded"
                      style={{ backgroundColor: floor.background_color }}
                    />
                    <div>
                      <p className="font-medium">{floor.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {allTableCounts[floor.id] || 0} tables
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={floor.is_active ? "default" : "secondary"}>
                      {floor.is_active ? "Active" : "Inactive"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setSelectedFloorId(floor.id);
                        setShowCreateTable(true);
                      }}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => deleteFloor.mutate(floor.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Table Dialog */}
      <Dialog open={showCreateTable} onOpenChange={setShowCreateTable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Table</DialogTitle>
            <DialogDescription>Add a new table to the floor.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Table Number</Label>
              <Input
                placeholder="e.g., 1, A1, T-01"
                value={newTable.table_number}
                onChange={(e) => setNewTable(prev => ({ ...prev, table_number: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Seats</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={newTable.seats}
                onChange={(e) => setNewTable(prev => ({ ...prev, seats: parseInt(e.target.value) || 4 }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Shape</Label>
              <Select 
                value={newTable.shape} 
                onValueChange={(v) => setNewTable(prev => ({ ...prev, shape: v as "square" | "round" | "rectangle" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="square">Square</SelectItem>
                  <SelectItem value="round">Round</SelectItem>
                  <SelectItem value="rectangle">Rectangle</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateTable(false)}>Cancel</Button>
            <Button onClick={handleCreateTable} disabled={createTable.isPending}>
              {createTable.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
