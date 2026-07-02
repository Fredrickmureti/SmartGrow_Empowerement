import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ArrowLeft, Menu, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { docSections } from "@/data/documentationContent";

export default function Documentation() {
  const [activeSection, setActiveSection] = useState("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const currentSection = docSections.find(s => s.id === activeSection) || docSections[0];

  const filteredSections = searchQuery.trim() 
    ? docSections.filter(section => 
        section.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        section.content.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : docSections;

  const handleSectionClick = (sectionId: string) => {
    setActiveSection(sectionId);
    setSidebarOpen(false);
    // Scroll to top when changing sections
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderContent = (content: string) => {
    const lines = content.split('\n');
    const elements: React.ReactElement[] = [];
    let inCodeBlock = false;
    let codeContent = '';
    let codeLanguage = '';

    lines.forEach((line, i) => {
      // Handle code blocks
      if (line.trim().startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLanguage = line.trim().slice(3);
          codeContent = '';
        } else {
          inCodeBlock = false;
          elements.push(
            <pre key={`code-${i}`} className="bg-muted rounded-lg p-4 overflow-x-auto my-4 text-xs sm:text-sm">
              <code className="text-foreground">{codeContent}</code>
            </pre>
          );
        }
        return;
      }

      if (inCodeBlock) {
        codeContent += (codeContent ? '\n' : '') + line;
        return;
      }

      // Handle headers
      if (line.startsWith('# ')) {
        elements.push(
          <h1 key={i} className="text-2xl sm:text-3xl md:text-4xl font-bold mt-8 mb-4 text-foreground">
            {line.slice(2)}
          </h1>
        );
      } else if (line.startsWith('## ')) {
        elements.push(
          <h2 key={i} className="text-xl sm:text-2xl md:text-3xl font-semibold mt-8 mb-4 text-foreground border-b pb-2">
            {line.slice(3)}
          </h2>
        );
      } else if (line.startsWith('### ')) {
        elements.push(
          <h3 key={i} className="text-lg sm:text-xl md:text-2xl font-semibold mt-6 mb-3 text-foreground">
            {line.slice(4)}
          </h3>
        );
      } else if (line.startsWith('#### ')) {
        elements.push(
          <h4 key={i} className="text-base sm:text-lg md:text-xl font-semibold mt-4 mb-2 text-foreground">
            {line.slice(5)}
          </h4>
        );
      } 
      // Handle tables
      else if (line.includes('|') && line.trim().startsWith('|')) {
        const cells = line.split('|').filter(cell => cell.trim());
        const isHeader = lines[i + 1]?.includes('---');
        const isSeparator = line.includes('---');
        
        if (!isSeparator) {
          elements.push(
            <div key={i} className={`grid gap-2 py-2 border-b text-xs sm:text-sm ${isHeader ? 'font-semibold bg-muted/50' : ''}`} 
                 style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}>
              {cells.map((cell, j) => (
                <div key={j} className="px-2">{cell.trim()}</div>
              ))}
            </div>
          );
        }
      }
      // Handle bold items with descriptions
      else if (line.startsWith('- **')) {
        const match = line.match(/- \*\*(.+?)\*\*:?\s*(.*)/);
        if (match) {
          elements.push(
            <div key={i} className="flex items-start gap-2 my-2 pl-4 text-sm sm:text-base">
              <span className="text-primary mt-1">•</span>
              <div>
                <strong className="text-foreground">{match[1]}</strong>
                {match[2] && <span className="text-muted-foreground">: {match[2]}</span>}
              </div>
            </div>
          );
        }
      }
      // Handle regular list items
      else if (line.startsWith('- ')) {
        elements.push(
          <div key={i} className="flex items-start gap-2 my-1.5 pl-4 text-sm sm:text-base text-muted-foreground">
            <span className="text-primary mt-1">•</span>
            <span>{line.slice(2)}</span>
          </div>
        );
      }
      // Handle numbered lists
      else if (line.match(/^\d+\.\s/)) {
        const match = line.match(/^(\d+)\.\s(.+)/);
        if (match) {
          elements.push(
            <div key={i} className="flex items-start gap-3 my-2 pl-4 text-sm sm:text-base">
              <span className="bg-primary text-primary-foreground w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0">
                {match[1]}
              </span>
              <span className="text-muted-foreground pt-0.5">{match[2]}</span>
            </div>
          );
        }
      }
      // Handle Q&A format
      else if (line.startsWith('**Q:')) {
        const question = line.match(/\*\*Q:\s*(.+?)\*\*/)?.[1];
        elements.push(
          <div key={i} className="bg-muted/30 rounded-lg p-4 my-3">
            <p className="font-semibold text-foreground text-sm sm:text-base">Q: {question}</p>
          </div>
        );
      }
      else if (line.startsWith('A:')) {
        elements.push(
          <p key={i} className="pl-4 mb-4 text-muted-foreground text-sm sm:text-base">{line.slice(2).trim()}</p>
        );
      }
      // Handle empty lines
      else if (line.trim() === '') {
        elements.push(<div key={i} className="h-2" />);
      }
      // Handle regular paragraphs
      else if (line.trim()) {
        // Parse inline formatting
        let formatted = line
          .replace(/\*\*(.+?)\*\*/g, '<strong class="text-foreground">$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/`(.+?)`/g, '<code class="bg-muted px-1.5 py-0.5 rounded text-sm">$1</code>');
        
        elements.push(
          <p 
            key={i} 
            className="my-2 text-sm sm:text-base text-muted-foreground leading-relaxed"
            dangerouslySetInnerHTML={{ __html: formatted }}
          />
        );
      }
    });

    return elements;
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      <h2 className="font-semibold mb-4 flex items-center gap-2 text-base sm:text-lg px-2">
        <currentSection.icon className="h-5 w-5 text-primary" />
        Documentation
      </h2>
      
      {/* Search */}
      <div className="px-2 mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search docs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <nav className="space-y-1 px-2">
          {filteredSections.map((section) => (
            <button
              key={section.id}
              onClick={() => handleSectionClick(section.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                activeSection === section.id
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <section.icon className="h-4 w-4 flex-shrink-0" />
              <span className="truncate text-left">{section.title}</span>
            </button>
          ))}
        </nav>
      </ScrollArea>

      {/* Quick stats */}
      <div className="border-t pt-4 mt-4 px-2">
        <p className="text-xs text-muted-foreground text-center">
          {docSections.length} comprehensive guides
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-4">
              {/* Mobile Menu Button */}
              <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="lg:hidden h-9 w-9">
                    <Menu className="h-5 w-5" />
                    <span className="sr-only">Toggle navigation</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[300px] p-4">
                  <SheetHeader className="mb-4">
                    <SheetTitle className="text-left">Navigation</SheetTitle>
                  </SheetHeader>
                  <SidebarContent />
                </SheetContent>
              </Sheet>
              
              <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground text-sm font-medium">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Back to Home</span>
                <span className="sm:hidden">Back</span>
              </Link>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <Button variant="ghost" size="sm" asChild className="text-sm h-9 px-3">
                <Link to="/help">Help Center</Link>
              </Button>
              <Button variant="outline" size="sm" asChild className="text-sm h-9 px-3">
                <Link to="/login">Sign In</Link>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-6 sm:py-8">
        <div className="flex gap-6 lg:gap-8">
          {/* Desktop Sidebar */}
          <aside className="hidden lg:block w-64 xl:w-72 shrink-0">
            <div className="sticky top-24 bg-card rounded-xl border p-4 max-h-[calc(100vh-8rem)] overflow-hidden">
              <SidebarContent />
            </div>
          </aside>

          {/* Content */}
          <main className="flex-1 min-w-0">
            <article className="bg-card rounded-xl border p-4 sm:p-6 lg:p-8">
              {/* Section Header */}
              <div className="flex items-center gap-3 sm:gap-4 mb-6 pb-6 border-b">
                <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <currentSection.icon className="h-6 w-6 sm:h-7 sm:w-7 text-primary" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground truncate">
                    {currentSection.title}
                  </h1>
                  <p className="text-sm text-muted-foreground">AccrualFlow Documentation</p>
                </div>
              </div>
              
              {/* Content */}
              <div className="prose prose-slate dark:prose-invert max-w-none">
                {renderContent(currentSection.content)}
              </div>

              {/* Navigation Footer */}
              <div className="flex items-center justify-between mt-12 pt-6 border-t">
                {docSections.findIndex(s => s.id === activeSection) > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const currentIndex = docSections.findIndex(s => s.id === activeSection);
                      handleSectionClick(docSections[currentIndex - 1].id);
                    }}
                    className="gap-2"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">
                      {docSections[docSections.findIndex(s => s.id === activeSection) - 1]?.title}
                    </span>
                    <span className="sm:hidden">Previous</span>
                  </Button>
                )}
                <div className="flex-1" />
                {docSections.findIndex(s => s.id === activeSection) < docSections.length - 1 && (
                  <Button
                    onClick={() => {
                      const currentIndex = docSections.findIndex(s => s.id === activeSection);
                      handleSectionClick(docSections[currentIndex + 1].id);
                    }}
                    className="gap-2"
                  >
                    <span className="hidden sm:inline">
                      {docSections[docSections.findIndex(s => s.id === activeSection) + 1]?.title}
                    </span>
                    <span className="sm:hidden">Next</span>
                    <ArrowLeft className="h-4 w-4 rotate-180" />
                  </Button>
                )}
              </div>
            </article>
          </main>
        </div>
      </div>
    </div>
  );
}
