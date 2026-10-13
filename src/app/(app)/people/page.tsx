import { redirect } from "next/navigation";

/** People are in the Directory now, under their bands. */
export default function PeoplePage() {
  redirect("/directory");
}
