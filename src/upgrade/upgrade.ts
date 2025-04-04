export default async function (): Promise<string> {
  await install();
  return 'Upgrade of "Huuma CLI" successful';
}

async function install(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["install", "-A", "-f", "-g", "-r", "-n", "huuma", "jsr:@huuma/cli"],
  });

  try {
    const res = await cmd.output();
    if (res.success) {
      return;
    }
    console.log(new TextDecoder().decode(res.stderr));
    throw new Error('Error during installation of "Huuma CLI"');
  } catch (e) {
    throw e;
  }
}
