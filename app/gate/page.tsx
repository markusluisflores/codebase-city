import { GateForm } from './GateForm';

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return (
    <main>
      <h1>Codebase City</h1>
      <p>Enter the demo password to analyse a repo that has not been analysed yet.</p>
      <GateForm next={typeof next === 'string' ? next : undefined} />
    </main>
  );
}
