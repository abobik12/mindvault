import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Layout from "@/components/layout";
import AuthPage from "@/pages/auth";
import Home from "@/pages/home";
import NotesPage from "@/pages/notes";
import FilesPage from "@/pages/files";
import RemindersPage from "@/pages/reminders";
import SettingsPage from "@/pages/settings";
import FolderPage from "@/pages/folder";

const queryClient = new QueryClient();

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const [location, setLocation] = useLocation();
  const token = typeof window !== "undefined" ? localStorage.getItem("mindvault_token") : null;
  
  if (!token) {
    setLocation("/auth");
    return null;
  }
  
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/auth" component={AuthPage} />
      <Route path="/" component={() => <ProtectedRoute component={Home} />} />
      <Route path="/notes" component={() => <ProtectedRoute component={NotesPage} />} />
      <Route path="/files" component={() => <ProtectedRoute component={FilesPage} />} />
      <Route path="/reminders" component={() => <ProtectedRoute component={RemindersPage} />} />
      <Route path="/folders/:id" component={() => <ProtectedRoute component={FolderPage} />} />
      <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
