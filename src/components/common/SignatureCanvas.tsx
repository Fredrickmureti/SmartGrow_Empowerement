import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Eraser, Pen, Type } from "lucide-react";

interface SignatureCanvasProps {
  onSignatureChange: (dataUrl: string | null) => void;
  initialSignature?: string | null;
  height?: number;
}

export function SignatureCanvas({
  onSignatureChange,
  initialSignature,
  height = 150,
}: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [typedSignature, setTypedSignature] = useState("");
  const [activeTab, setActiveTab] = useState<string>("draw");

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = height;

    // Set drawing style
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Fill with white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw initial signature if provided
    if (initialSignature) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
      };
      img.src = initialSignature;
    }
  }, [height, initialSignature]);

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    
    if ("touches" in e) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top,
      };
    }
    
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    setIsDrawing(true);
    const { x, y } = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;

    const { x, y } = getCoordinates(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (isDrawing) {
      setIsDrawing(false);
      saveSignature();
    }
  };

  const saveSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const dataUrl = canvas.toDataURL("image/png");
    onSignatureChange(dataUrl);
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    onSignatureChange(null);
  };

  const handleTypedSignature = (text: string) => {
    setTypedSignature(text);
    
    if (!text.trim()) {
      onSignatureChange(null);
      return;
    }

    // Create signature from text
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Signature text with cursive font
    ctx.font = "italic 36px 'Brush Script MT', cursive, serif";
    ctx.fillStyle = "#1a1a1a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    onSignatureChange(canvas.toDataURL("image/png"));
  };

  return (
    <div className="space-y-3">
      <Label>Signature</Label>
      
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="draw" className="text-xs">
            <Pen className="h-3 w-3 mr-1" />
            Draw
          </TabsTrigger>
          <TabsTrigger value="type" className="text-xs">
            <Type className="h-3 w-3 mr-1" />
            Type
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="draw" className="mt-3">
          <div className="space-y-2">
            <div className="border rounded-lg overflow-hidden bg-white">
              <canvas
                ref={canvasRef}
                className="w-full cursor-crosshair touch-none"
                style={{ height }}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                onTouchStart={startDrawing}
                onTouchMove={draw}
                onTouchEnd={stopDrawing}
              />
            </div>
            <div className="flex justify-between items-center">
              <p className="text-xs text-muted-foreground">
                Draw your signature above
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearCanvas}
              >
                <Eraser className="h-3 w-3 mr-1" />
                Clear
              </Button>
            </div>
          </div>
        </TabsContent>
        
        <TabsContent value="type" className="mt-3">
          <div className="space-y-3">
            <Input
              placeholder="Type your name"
              value={typedSignature}
              onChange={(e) => handleTypedSignature(e.target.value)}
              className="text-center"
            />
            {typedSignature && (
              <div 
                className="border rounded-lg p-4 bg-white text-center"
                style={{ height }}
              >
                <span 
                  className="text-3xl italic text-foreground"
                  style={{ fontFamily: "'Brush Script MT', cursive, serif" }}
                >
                  {typedSignature}
                </span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Your typed name will be rendered as a signature
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
