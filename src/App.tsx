import { useStore } from "./lib/store";
import { LaunchScreen } from "./components/LaunchScreen";
import { Editor } from "./components/Editor";

export default function App() {
  const view = useStore((s) => s.view);
  return view === "launch" ? <LaunchScreen /> : <Editor />;
}
