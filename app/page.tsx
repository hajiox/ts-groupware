import { redirect } from "next/navigation";

/**
 * / ルートはログインページにリダイレクト
 */
export default function RootPage() {
  redirect("/login");
}
